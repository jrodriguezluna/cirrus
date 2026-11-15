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

const tag = (m) => (m.caseRef ? ` [${m.caseRef}]` : '');
const refLines = (m) => (m.caseRef ? [`Referencia: ${m.caseRef}`, ''] : []);
const when = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const readLines = (m) => ((m.readLog ?? []).length
  ? ['Lecturas:', ...m.readLog.map((t, i) => `  ${i + 1}) ${when(t)}`), '']
  : []);

function steps(m) {
  const kid = m.keyId ?? 'TU_KEY_ID';
  const gkey = m.keyId ?? 'KEY_ID';
  const acct = m.account ?? 'SA_EMAIL';
  switch (m.credClass) {
    case 'aws-access-key':
      return [
        `Desactiva la key (reversible):\n   aws iam update-access-key --user-name USUARIO --access-key-id ${kid} --status Inactive`,
        `Confirma que nada se rompió y elimínala:\n   aws iam delete-access-key --user-name USUARIO --access-key-id ${kid}`,
        'Revisa su actividad reciente en CloudTrail.',
      ];
    case 'aws-temp':
      return ['Es una credencial temporal: expira sola. Revoca las sesiones del rol en IAM solo si su duración era larga.'];
    case 'gcp-sa':
      return [
        `Desactiva la clave (reversible):\n   gcloud iam service-accounts keys disable ${gkey} --iam-account=${acct}`,
        `Confirma que nada se rompió y elimínala:\n   gcloud iam service-accounts keys delete ${gkey} --iam-account=${acct}`,
        'Revisa su actividad reciente en Cloud Audit Logs.',
      ];
    case 'azure-secret':
      return [
        'Ubica el secreto en la aplicación:\n   az ad app credential list --id APP_ID',
        'Elimínalo:\n   az ad app credential delete --id APP_ID --key-id KEY_ID',
        'Revisa los inicios de sesión recientes de la aplicación en Microsoft Entra.',
      ];
    case 'github-token':
      return [
        'Elimina el token en GitHub: Settings > Developer settings > Personal access tokens.',
        'Revisa el registro de auditoría de la cuenta u organización en busca de uso inesperado.',
      ];
    case 'slack-token':
      return [
        'Revoca el token desde la configuración de la app en api.slack.com/apps (o reinstala la app para regenerarlo).',
        'Revisa los registros de acceso del workspace.',
      ];
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
  'Cuando hayas rotado, confirma aquí (abre el link y pulsa el botón):',
  `  ${process.env.SITE_URL}/ack.html#${id}:${m.ackToken}`,
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
    `Cirrus${tag(m)}: tu secreto se leyó (${m.reads ?? 0} de ${m.maxUses})`,
    [
      ...refLines(m),
      `Tu secreto ${id.slice(0, 6)}… se consumió. El link ya no sirve, pero la credencial SIGUE ACTIVA en su cuenta de origen.`,
      '',
      ...readLines(m),
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
      `Cirrus${tag(m)}: tu secreto expiró con ${reads} de ${m.maxUses} lecturas`,
      [
        ...refLines(m),
        `Tu secreto ${id.slice(0, 6)}… expiró. Se leyó ${reads} de ${m.maxUses} veces.`,
        'Como alguien lo leyó, la credencial sigue activa y expuesta.',
        '',
        ...readLines(m),
        'Checklist de rotación:',
        checklist(m),
        '',
        ackHelp(id, m),
      ].join('\n'));
  } else {
    await mail(m.notifyEmail,
      `Cirrus${tag(m)}: tu secreto expiró sin leerse`,
      [
        ...refLines(m),
        `Tu secreto ${id.slice(0, 6)}… expiró sin que nadie lo leyera. Si ya no necesitas esa credencial, desactívala igualmente.`,
      ].join('\n'));
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
    `Cirrus${tag(m)}: recordatorio ${m.attempts} de 3, rota la credencial`,
    [
      ...refLines(m),
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
    `Cirrus${tag(m)}: último aviso, la credencial podría seguir activa`,
    [
      ...refLines(m),
      `Enviamos 3 recordatorios sobre el secreto ${id.slice(0, 6)}… sin confirmación. Dejamos de insistir; la credencial podría seguir activa.`,
    ].join('\n'));
  return { ok: true };
}

const actions = { register, notifyRead, notifyExpired, checkAck, sendReminder, giveUp };

export const handler = async (event) => {
  const fn = actions[event.action];
  if (!fn) throw new Error('unknown_action');
  return fn(event);
};
