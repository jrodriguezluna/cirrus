import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});
const sfn = new SFNClient({});
const TableName = process.env.TABLE;

const metaKey = (id) => ({ pk: `META#${id}` });
const getMeta = async (id) => (await ddb.send(new GetCommand({ TableName, Key: metaKey(id) }))).Item;
const setStatus = (id, status) => ddb.send(new UpdateCommand({
  TableName, Key: metaKey(id),
  UpdateExpression: 'SET #s = :s',
  ExpressionAttributeNames: { '#s': 'status' },
  ExpressionAttributeValues: { ':s': status },
}));

async function mail(to, subject, text) {
  if (!to) return;
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SENDER,
      Destination: { ToAddresses: [to] },
      Content: { Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' } },
      } },
    }));
  } catch (e) {
    console.error('ses_failed', e.name); // nunca loguear el email ni el contenido
  }
}

function steps(m) {
  const kid = m.keyId ?? 'TU_KEY_ID';
  switch (m.credClass) {
    case 'aws-access-key':
      return [
        `Desactiva la key (reversible):\n   aws iam update-access-key --user-name USUARIO --access-key-id ${kid} --status Inactive`,
        `Confirma que nada se rompió y elimínala:\n   aws iam delete-access-key --user-name USUARIO --access-key-id ${kid}`,
        'Revisa su actividad reciente en CloudTrail.',
      ];
    case 'aws-temp':
      return ['Es una credencial temporal: expira sola. Revoca las sesiones del rol en IAM solo si su duración era larga.'];
    case 'pem':
      return ['Genera un par de claves nuevo, reemplaza la clave pública autorizada y elimina la anterior.'];
    case 'conn-string':
      return ['Cambia la contraseña del usuario de la base de datos y actualiza las aplicaciones que la usan.'];
    case 'env':
      return ['Rota cada secreto contenido en el archivo .env.'];
    default:
      return ['Rota o revoca la credencial en el sistema de origen.'];
  }
}

const checklist = (m) => steps(m).map((s, i) => `${i + 1}. ${s}`).join('\n');

const ackHelp = (id, m) => [
  'Cuando hayas rotado, confirma (por ahora con curl; luego será un botón en la web):',
  `  curl -X POST https://${m.apiHost}/api/ack -H 'Content-Type: application/json' -d '{"id":"${id}","ackToken":"${m.ackToken}"}'`,
].join('\n');

async function register({ id, taskToken }) {
  await ddb.send(new UpdateCommand({
    TableName, Key: metaKey(id),
    UpdateExpression: 'SET taskToken = :t',
    ExpressionAttributeValues: { ':t': taskToken },
  }));
  // Si el secreto ya se consumió antes de registrar el token, avisar nosotros
  const sec = await ddb.send(new GetCommand({ TableName, Key: { pk: `SEC#${id}` } }));
  if (!sec.Item) {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: '{}' })).catch(() => {});
  }
  return { ok: true };
}

async function notifyRead({ id }) {
  const m = await getMeta(id);
  await setStatus(id, 'READ');
  await mail(m.notifyEmail,
    `Cirrus: tu secreto se leyó (${m.reads ?? 0} de ${m.maxUses})`,
    [
      `Tu secreto ${id.slice(0, 6)}… se consumió. El link ya no sirve, pero la credencial SIGUE ACTIVA en su cuenta de origen.`,
      '',
      'Checklist de rotación:',
      checklist(m),
      '',
      ackHelp(id, m),
    ].join('\n'));
  return { ok: true };
}

async function notifyExpired({ id }) {
  const m = await getMeta(id);
  await ddb.send(new DeleteCommand({ TableName, Key: { pk: `SEC#${id}` } }));
  const reads = m.reads ?? 0;
  await setStatus(id, 'EXPIRED');
  if (reads > 0) {
    await mail(m.notifyEmail,
      `Cirrus: tu secreto expiró con ${reads} de ${m.maxUses} lecturas`,
      [
        `Tu secreto ${id.slice(0, 6)}… expiró. Se leyó ${reads} de ${m.maxUses} veces.`,
        'Como alguien lo leyó, la credencial sigue activa y expuesta.',
        '',
        'Checklist de rotación:',
        checklist(m),
        '',
        ackHelp(id, m),
      ].join('\n'));
  } else {
    await mail(m.notifyEmail,
      'Cirrus: tu secreto expiró sin leerse',
      `Tu secreto ${id.slice(0, 6)}… expiró sin que nadie lo leyera. Si ya no necesitas esa credencial, desactívala igualmente.`);
  }
  return { reads };
}

async function checkAck({ id }) {
  const m = await getMeta(id);
  return { acked: m.status === 'ACKED', attempts: m.attempts ?? 0 };
}

async function sendReminder({ id }) {
  const r = await ddb.send(new UpdateCommand({
    TableName, Key: metaKey(id),
    UpdateExpression: 'ADD #a :one',
    ExpressionAttributeNames: { '#a': 'attempts' },
    ExpressionAttributeValues: { ':one': 1 },
    ReturnValues: 'ALL_NEW',
  }));
  const m = r.Attributes;
  await mail(m.notifyEmail,
    `Cirrus: recordatorio ${m.attempts} de 3, rota la credencial`,
    [
      `Aún no confirmaste la rotación del secreto ${id.slice(0, 6)}….`,
      '',
      'Checklist de rotación:',
      checklist(m),
      '',
      ackHelp(id, m),
    ].join('\n'));
  return { ok: true };
}

async function giveUp({ id }) {
  const m = await getMeta(id);
  await setStatus(id, 'GAVE_UP');
  await mail(m.notifyEmail,
    'Cirrus: último aviso, la credencial podría seguir activa',
    `Enviamos 3 recordatorios sobre el secreto ${id.slice(0, 6)}… sin confirmación. Dejamos de insistir; la credencial podría seguir activa.`);
  return { ok: true };
}

const actions = { register, notifyRead, notifyExpired, checkAck, sendReminder, giveUp };

export const handler = async (event) => {
  const fn = actions[event.action];
  if (!fn) throw new Error('unknown_action');
  return fn(event);
};
