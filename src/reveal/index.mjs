import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const id = event.pathParameters?.id ?? '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return reply(404, { error: 'not_found_or_used' });
  const Key = { pk: `SEC#${id}` };
  const now = Math.floor(Date.now() / 1000);

  let item;
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: process.env.TABLE,
      Key,
      UpdateExpression: 'SET usesLeft = usesLeft - :one',
      ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND usesLeft > :zero',
      ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': now },
      ReturnValues: 'ALL_NEW',
    }));
    item = r.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return reply(404, { error: 'not_found_or_used' });
    throw e;
  }

  if (item.usesLeft === 0) {
    // Último uso: borrar el texto cifrado (si falla, la condición ya impide más lecturas)
    await ddb.send(new DeleteCommand({
      TableName: process.env.TABLE,
      Key,
      ConditionExpression: 'usesLeft = :zero',
      ExpressionAttributeValues: { ':zero': 0 },
    })).catch(() => {});
  }
  return reply(200, { ct: item.ct, iv: item.iv, usesLeft: item.usesLeft, maxUses: item.maxUses });
};
