import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { render } from './email.mjs';

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

// Envía un correo con dos versiones del mismo contenido: HTML y texto plano.
// `model` = { heading, blocks } (ver email.mjs). Sin destinatario no hace nada.
async function mail(to, subject, model) {
  if (!to) return;
  const { text, html } = render(model);
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SENDER,
      Destination: { ToAddresses: [to] },
      Content: { Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } },
      } },
    }));
  } catch (e) {
    console.error('ses_failed', e.name); // nunca loguear el email ni el contenido
  }
}

const tag = (m) => (m.caseRef ? ` [${m.caseRef}]` : '');
const when = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const short = (id) => `${id.slice(0, 6)}…`;
const queda = (n, max) => `${n === 1 ? 'Queda 1 uso' : `Quedan ${n} usos`} de ${max}`;

function steps(m) {
  const kid = m.keyId ?? 'TU_KEY_ID';
  const gkey = m.keyId ?? 'KEY_ID';
  const acct = m.account ?? 'SA_EMAIL';
  // Un paso puede llevar un comando: va tras "\n   " (se muestra aparte en el HTML)
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

// ---------- bloques reutilizables de los correos
const refBlock = (m) => (m.caseRef ? [{ type: 'ref', value: m.caseRef }] : []);
const readsBlock = (m) => ((m.readLog ?? []).length ? [{ type: 'reads', items: m.readLog.map(when) }] : []);
const checklistBlock = (m) => ({
  type: 'steps', title: 'Checklist de rotación',
  items: steps(m).map((s) => { const [text, ...code] = s.split('\n   '); return { text, code: code.join('\n') || undefined }; }),
});
const ackBlock = (id, m) => ({
  type: 'action',
  intro: 'Cuando hayas rotado, confirma aquí (abre el link y pulsa el botón):',
  label: 'Confirmar que roté la credencial',
  url: `${process.env.SITE_URL}/ack.html#${id}:${m.ackToken}`,
});

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

async function notifyFirstRead({ id }) {
  const m = await getMeta(id);
  if (!m?.notifyEmail) return { ok: true }; // sin email opt-in, nada que hacer
  const left = (m.maxUses ?? 1) - (m.reads ?? 1);
  await mail(m.notifyEmail,
    `Cirrus${tag(m)}: primer acceso al secreto (${m.reads ?? 1} de ${m.maxUses})`,
    {
      heading: 'Tu secreto se abrió por primera vez',
      blocks: [
        ...refBlock(m),
        { type: 'p', text: `Tu secreto ${short(id)} fue abierto por primera vez. ${queda(left, m.maxUses)}.` },
        { type: 'p', text: 'El link sigue activo hasta que se agoten los usos o expire.' },
        ...readsBlock(m),
      ],
    });
  return { ok: true };
}

// Seguimiento = avisar cuando se lee o expira. Rotación = además checklist, recordatorios y confirmación.
// Los secretos creados antes de esta opción no tienen `rotate`: se tratan como con rotación.
const rotates = (m) => m.rotate !== false;

async function notifyRead({ id }) {
  const m = await getMeta(id);
  await setStatus(id, 'READ');
  const rotate = rotates(m);
  await mail(m.notifyEmail,
    `Cirrus${tag(m)}: tu secreto se leyó por completo (${m.reads ?? 0} de ${m.maxUses})`,
    {
      heading: 'Tu secreto se leyó por completo',
      blocks: [
        ...refBlock(m),
        { type: 'p', text: `Tu secreto ${short(id)} agotó sus usos. El link ya no sirve.` },
        ...(rotate ? [{ type: 'alert', text: 'Pero la credencial SIGUE ACTIVA en su cuenta de origen.' }] : []),
        ...readsBlock(m),
        ...(rotate ? [checklistBlock(m), ackBlock(id, m)] : []),
      ],
    });
  return { ok: true };
}

async function notifyExpired({ id }) {
  const m = await getMeta(id);
  await ddb.send(new DeleteCommand({ TableName, Key: { pk: `SEC#${id}` } }));
  const reads = m.reads ?? 0;
  await setStatus(id, 'EXPIRED');
  const rotate = rotates(m);
  if (reads > 0) {
    await mail(m.notifyEmail,
      `Cirrus${tag(m)}: tu secreto expiró con ${reads} de ${m.maxUses} lecturas`,
      {
        heading: 'Tu secreto expiró',
        blocks: [
          ...refBlock(m),
          { type: 'p', text: `Tu secreto ${short(id)} expiró. Se leyó ${reads} de ${m.maxUses} veces.` },
          ...(rotate ? [{ type: 'alert', text: 'Como alguien lo leyó, la credencial sigue activa y expuesta.' }] : []),
          ...readsBlock(m),
          ...(rotate ? [checklistBlock(m), ackBlock(id, m)] : []),
        ],
      });
  } else {
    await mail(m.notifyEmail,
      `Cirrus${tag(m)}: tu secreto expiró sin leerse`,
      {
        heading: 'Tu secreto expiró sin leerse',
        blocks: [
          ...refBlock(m),
          { type: 'p', text: `Tu secreto ${short(id)} expiró sin que nadie lo leyera.${rotate ? ' Si ya no necesitas esa credencial, desactívala igualmente.' : ''}` },
        ],
      });
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
    {
      heading: `Recordatorio ${m.attempts} de 3: rota la credencial`,
      blocks: [
        ...refBlock(m),
        { type: 'p', text: `Aún no confirmaste la rotación del secreto ${short(id)}.` },
        checklistBlock(m),
        ackBlock(id, m),
      ],
    });
  return { ok: true };
}

async function giveUp({ id }) {
  const m = await getMeta(id);
  await setStatus(id, 'GAVE_UP');
  await mail(m.notifyEmail,
    `Cirrus${tag(m)}: último aviso, la credencial podría seguir activa`,
    {
      heading: 'Último aviso',
      blocks: [
        ...refBlock(m),
        { type: 'p', text: `Enviamos 3 recordatorios sobre el secreto ${short(id)} sin confirmación. Dejamos de insistir; la credencial podría seguir activa.` },
      ],
    });
  return { ok: true };
}

const actions = { register, notifyFirstRead, notifyRead, notifyExpired, checkAck, sendReminder, giveUp };

export const handler = async (event) => {
  const fn = actions[event.action];
  if (!fn) throw new Error('unknown_action');
  return fn(event);
};
