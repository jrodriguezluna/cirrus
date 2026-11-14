import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';

const MAX_USES = 5;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const b64u = /^[A-Za-z0-9_-]+$/;
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  let data;
  try {
    data = JSON.parse(event.body ?? '');
  } catch {
    return reply(400, { error: 'invalid_json' });
  }
  const { ct, iv, ttlSeconds } = data;
  const maxUses = data.maxUses ?? 1;
  if (typeof ct !== 'string' || !b64u.test(ct) || ct.length > 24000) return reply(400, { error: 'invalid_ct' });
  if (typeof iv !== 'string' || !b64u.test(iv) || iv.length > 64) return reply(400, { error: 'invalid_iv' });
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800) return reply(400, { error: 'invalid_ttl' });
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES) return reply(400, { error: 'invalid_max_uses' });

  const id = randomBytes(16).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(new PutCommand({
    TableName: process.env.TABLE,
    Item: {
      pk: `SEC#${id}`, ct, iv,
      maxUses, usesLeft: maxUses,
      expiresAt: now + ttlSeconds, ttl: now + ttlSeconds + 3600,
    },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
  return reply(201, { id, maxUses });
};
