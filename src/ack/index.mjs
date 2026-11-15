import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { timingSafeEqual } from 'node:crypto';

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
  let data;
  try { data = JSON.parse(event.body ?? ''); } catch { return reply(400, { error: 'invalid_json' }); }
  const { id, ackToken } = data;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id) || typeof ackToken !== 'string') {
    return reply(400, { error: 'invalid_request' });
  }
  const Key = { pk: `META#${id}` };
  const { Item } = await ddb.send(new GetCommand({ TableName: process.env.TABLE, Key }));
  if (!Item?.ackToken || !same(ackToken, Item.ackToken)) return reply(404, { error: 'not_found' });
  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE, Key,
    UpdateExpression: 'SET #s = :s',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'ACKED' },
  }));
  return reply(200, { status: 'ACKED' });
};
