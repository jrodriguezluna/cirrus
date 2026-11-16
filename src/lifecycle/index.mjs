import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { render } from './email.mjs';
import { messages, normalizeLang } from './messages.mjs';

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
// `model` = { heading, blocks } (ver email.mjs); `lang` es el idioma del emisor. Sin destinatario no hace nada.
async function mail(to, subject, model, lang) {
  if (!to) return;
  const { text, html } = render({ ...model, lang });
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
// Idioma del emisor (META.lang). Los secretos anteriores a esta opción no lo tienen: español.
const msgs = (m) => messages(m?.lang);

// ---------- bloques reutilizables de los correos
const refBlock = (m) => (m.caseRef ? [{ type: 'ref', value: m.caseRef }] : []);
const readsBlock = (m) => ((m.readLog ?? []).length ? [{ type: 'reads', items: m.readLog.map(when) }] : []);
const checklistBlock = (m) => ({
  type: 'steps', title: msgs(m).checklistTitle,
  items: msgs(m).checklist(m).map((s) => { const [text, ...code] = s.split('\n   '); return { text, code: code.join('\n') || undefined }; }),
});
// El link lleva ?lang= para que la página de confirmación se abra en el idioma del correo
const ackBlock = (id, m) => ({
  type: 'action',
  intro: msgs(m).ack.intro,
  label: msgs(m).ack.label,
  url: `${process.env.SITE_URL}/ack.html?lang=${normalizeLang(m.lang)}#${id}:${m.ackToken}`,
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
  const x = msgs(m).firstRead;
  await mail(m.notifyEmail,
    x.subject(tag(m), m.reads ?? 1, m.maxUses),
    {
      heading: x.heading,
      blocks: [
        ...refBlock(m),
        { type: 'p', text: x.opened(short(id), left, m.maxUses) },
        { type: 'p', text: x.stillActive },
        ...readsBlock(m),
      ],
    }, m.lang);
  return { ok: true };
}

// Seguimiento = avisar cuando se lee o expira. Rotación = además checklist, recordatorios y confirmación.
// Los secretos creados antes de esta opción no tienen `rotate`: se tratan como con rotación.
const rotates = (m) => m.rotate !== false;

async function notifyRead({ id }) {
  const m = await getMeta(id);
  await setStatus(id, 'READ');
  const rotate = rotates(m);
  const x = msgs(m).read;
  await mail(m.notifyEmail,
    x.subject(tag(m), m.reads ?? 0, m.maxUses),
    {
      heading: x.heading,
      blocks: [
        ...refBlock(m),
        { type: 'p', text: x.exhausted(short(id)) },
        ...(rotate ? [{ type: 'alert', text: x.stillAlive }] : []),
        ...readsBlock(m),
        ...(rotate ? [checklistBlock(m), ackBlock(id, m)] : []),
      ],
    }, m.lang);
  return { ok: true };
}

async function notifyExpired({ id }) {
  const m = await getMeta(id);
  await ddb.send(new DeleteCommand({ TableName, Key: { pk: `SEC#${id}` } }));
  const reads = m.reads ?? 0;
  await setStatus(id, 'EXPIRED');
  const rotate = rotates(m);
  const x = msgs(m).expired;
  if (reads > 0) {
    await mail(m.notifyEmail,
      x.subjectRead(tag(m), reads, m.maxUses),
      {
        heading: x.headingRead,
        blocks: [
          ...refBlock(m),
          { type: 'p', text: x.bodyRead(short(id), reads, m.maxUses) },
          ...(rotate ? [{ type: 'alert', text: x.exposed }] : []),
          ...readsBlock(m),
          ...(rotate ? [checklistBlock(m), ackBlock(id, m)] : []),
        ],
      }, m.lang);
  } else {
    await mail(m.notifyEmail,
      x.subjectUnread(tag(m)),
      {
        heading: x.headingUnread,
        blocks: [
          ...refBlock(m),
          { type: 'p', text: x.bodyUnread(short(id), rotate) },
        ],
      }, m.lang);
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
  const x = msgs(m).reminder;
  await mail(m.notifyEmail,
    x.subject(tag(m), m.attempts),
    {
      heading: x.heading(m.attempts),
      blocks: [
        ...refBlock(m),
        { type: 'p', text: x.body(short(id)) },
        checklistBlock(m),
        ackBlock(id, m),
      ],
    }, m.lang);
  return { ok: true };
}

async function giveUp({ id }) {
  const m = await getMeta(id);
  await setStatus(id, 'GAVE_UP');
  const x = msgs(m).giveUp;
  await mail(m.notifyEmail,
    x.subject(tag(m)),
    {
      heading: x.heading,
      blocks: [
        ...refBlock(m),
        { type: 'p', text: x.body(short(id)) },
      ],
    }, m.lang);
  return { ok: true };
}

const actions = { register, notifyFirstRead, notifyRead, notifyExpired, checkAck, sendReminder, giveUp };

export const handler = async (event) => {
  const fn = actions[event.action];
  if (!fn) throw new Error('unknown_action');
  return fn(event);
};
