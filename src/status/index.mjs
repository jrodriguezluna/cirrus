import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, timingSafeEqual } from 'node:crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export const handler = async (event) => {
  const id = event.pathParameters?.id ?? '';
  const token = event.headers?.['x-status-token'] ?? '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !token) return reply(404, { error: 'not_found' });
  const { Item } = await ddb.send(new GetCommand({
    TableName: process.env.TABLE, Key: { pk: `META#${id}` }, ConsistentRead: true,
  }));
  const hash = createHash('sha256').update(token).digest('hex');
  if (!Item?.statusTokenHash || !same(hash, Item.statusTokenHash)) return reply(404, { error: 'not_found' });
  return reply(200, {
    status: Item.status,
    createdAt: Item.createdAt,
    expiresAt: Item.expiresAt ?? null,
    reads: Item.reads ?? 0,
    maxUses: Item.maxUses,
    attempts: Item.attempts ?? 0,
    notify: Boolean(Item.notifyEmail),
    caseRef: Item.caseRef ?? null,
    readLog: Item.readLog ?? [],
  });
};
