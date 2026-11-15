import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomBytes, createHash } from 'node:crypto';

const MAX_USES = 5;
const REMINDER_WAIT = Number(process.env.REMINDER_WAIT ?? 86400);
const CLASSES = ['aws-access-key', 'aws-temp', 'pem', 'conn-string', 'env', 'generic'];
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
  const { ct, iv, ttlSeconds } = data;
  const maxUses = data.maxUses ?? 1;
  if (typeof ct !== 'string' || !b64u.test(ct) || ct.length > 24000) return reply(400, { error: 'invalid_ct' });
  if (typeof iv !== 'string' || !b64u.test(iv) || iv.length > 64) return reply(400, { error: 'invalid_iv' });
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800) return reply(400, { error: 'invalid_ttl' });
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES) return reply(400, { error: 'invalid_max_uses' });

  // Aviso opcional (opt-in): email, tipo de credencial y, si se quiere, el AccessKeyId
  let notify = null;
  if (data.notify) {
    const { email, credClass = 'generic', keyId } = data.notify;
    if (typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply(400, { error: 'invalid_email' });
    }
    if (!CLASSES.includes(credClass)) return reply(400, { error: 'invalid_class' });
    if (keyId !== undefined && !/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(keyId)) return reply(400, { error: 'invalid_key_id' });
    notify = { email, credClass, keyId };
  }

  const id = randomBytes(16).toString('base64url');
  const statusToken = randomBytes(16).toString('base64url');
  const ackToken = randomBytes(16).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;

  const meta = {
    pk: `META#${id}`, status: 'CREATED', createdAt: now, maxUses, reads: 0, attempts: 0,
    statusTokenHash: createHash('sha256').update(statusToken).digest('hex'),
    ackToken,
    apiHost: event.requestContext?.domainName,
    expiresAt,
    ttl: expiresAt + 30 * 86400,
  };
  if (notify) {
    meta.notifyEmail = notify.email;
    meta.credClass = notify.credClass;
    if (notify.keyId) meta.keyId = notify.keyId;
  }

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: {
        TableName: process.env.TABLE,
        Item: { pk: `SEC#${id}`, ct, iv, maxUses, usesLeft: maxUses, expiresAt, ttl: expiresAt + 3600 },
        ConditionExpression: 'attribute_not_exists(pk)',
      } },
      { Put: { TableName: process.env.TABLE, Item: meta } },
    ],
  }));

  if (notify) {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE,
      name: id,
      input: JSON.stringify({ id, waitSeconds: ttlSeconds + 5, reminderWait: REMINDER_WAIT }),
    }));
  }
  return reply(201, { id, maxUses, statusToken });
};
