import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomBytes, createHash } from 'node:crypto';

const MAX_USES = 5;
const PASS_MIN_LEN = 12; // aplicado en el frontend; documentado aquí para consistencia con el threat model
const REMINDER_WAIT = Number(process.env.REMINDER_WAIT ?? 86400);
const CLASSES = ['aws-access-key', 'aws-temp', 'gcp-sa', 'azure-secret', 'github-token', 'slack-token', 'pem', 'conn-string', 'env', 'generic'];
const KEY_ID = {
  'aws-access-key': /^AKIA[0-9A-Z]{16}$/,
  'aws-temp': /^ASIA[0-9A-Z]{16}$/,
  'gcp-sa': /^[0-9a-f]{40}$/,
};
const LANGS = ['es', 'en']; // idiomas de los correos; mantener en sync con src/lifecycle/messages.mjs
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const b64u = /^[A-Za-z0-9_-]+$/;
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  let data;
  try { data = JSON.parse(event.body ?? ''); } catch { return reply(400, { error: 'invalid_json' }); }
  const { ct, iv, ttlSeconds, caseRef } = data;
  const maxUses = data.maxUses ?? 1;
  if (typeof ct !== 'string' || !b64u.test(ct) || ct.length > 24000) return reply(400, { error: 'invalid_ct' });
  if (typeof iv !== 'string' || !b64u.test(iv) || iv.length > 64) return reply(400, { error: 'invalid_iv' });
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800) return reply(400, { error: 'invalid_ttl' });
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES) return reply(400, { error: 'invalid_max_uses' });
  if (data.pass !== undefined && typeof data.pass !== 'boolean') return reply(400, { error: 'invalid_pass' });
  if (caseRef !== undefined && (typeof caseRef !== 'string' || caseRef.length < 1 || caseRef.length > 80 || /[\u0000-\u001F\u007F<>]/.test(caseRef))) {
    return reply(400, { error: 'invalid_ref' });
  }

  // Seguimiento opcional (opt-in): email para avisar cuando se lea o expire.
  // `rotate` añade el ciclo de rotación (checklist, recordatorios, confirmación); por defecto
  // true para clientes anteriores a esta opción. `lang` es el idioma de los correos (por defecto español).
  let notify = null;
  if (data.notify) {
    const { email, credClass = 'generic', keyId, account, rotate = true, lang = 'es' } = data.notify;
    if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email)) return reply(400, { error: 'invalid_email' });
    if (typeof rotate !== 'boolean') return reply(400, { error: 'invalid_rotate' });
    if (!LANGS.includes(lang)) return reply(400, { error: 'invalid_lang' });
    if (!CLASSES.includes(credClass)) return reply(400, { error: 'invalid_class' });
    if (keyId !== undefined && !KEY_ID[credClass]?.test(keyId)) return reply(400, { error: 'invalid_key_id' });
    if (account !== undefined && (credClass !== 'gcp-sa' || typeof account !== 'string' || account.length > 254 || !EMAIL.test(account))) {
      return reply(400, { error: 'invalid_account' });
    }
    notify = { email, credClass, keyId, account, rotate, lang };
  }

  const id = randomBytes(16).toString('base64url');
  const statusToken = randomBytes(16).toString('base64url');
  const ackToken = randomBytes(16).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const pass = data.pass === true;

  const meta = {
    pk: `META#${id}`, status: 'CREATED', createdAt: now, maxUses, reads: 0, attempts: 0, pass,
    statusTokenHash: createHash('sha256').update(statusToken).digest('hex'),
    ackToken,
    apiHost: event.requestContext?.domainName,
    expiresAt,
    ttl: expiresAt + 30 * 86400,
  };
  if (caseRef) meta.caseRef = caseRef;
  if (notify) {
    meta.notifyEmail = notify.email;
    meta.rotate = notify.rotate;
    meta.lang = notify.lang;
    // El tipo de credencial solo sirve para el checklist de rotación: sin rotación no se guarda
    if (notify.rotate) {
      meta.credClass = notify.credClass;
      if (notify.keyId) meta.keyId = notify.keyId;
      if (notify.account) meta.account = notify.account;
    }
  }

  const secret = { pk: `SEC#${id}`, ct, iv, maxUses, usesLeft: maxUses, expiresAt, ttl: expiresAt + 3600, pass };
  if (caseRef) secret.caseRef = caseRef;

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: process.env.TABLE, Item: secret, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: process.env.TABLE, Item: meta } },
    ],
  }));

  if (notify) {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE,
      name: id,
      input: JSON.stringify({ id, waitSeconds: ttlSeconds + 5, reminderWait: REMINDER_WAIT, rotate: notify.rotate }),
    }));
  }
  return reply(201, { id, maxUses, statusToken });
};
