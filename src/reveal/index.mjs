import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const TableName = process.env.TABLE;
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
      TableName, Key,
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
    await ddb.send(new DeleteCommand({
      TableName, Key,
      ConditionExpression: 'usesLeft = :zero',
      ExpressionAttributeValues: { ':zero': 0 },
    })).catch(() => {});
  }

  // Registrar la lectura y, si fue la última, despertar a Step Functions.
  // Un fallo aquí nunca debe impedir la entrega del secreto.
  try {
    const m = await ddb.send(new UpdateCommand({
      TableName, Key: { pk: `META#${id}` },
      UpdateExpression: 'ADD #r :one SET lastReadAt = :now',
      ExpressionAttributeNames: { '#r': 'reads' },
      ExpressionAttributeValues: { ':one': 1, ':now': now },
      ReturnValues: 'ALL_NEW',
    }));
    if (item.usesLeft === 0 && m.Attributes?.taskToken) {
      await sfn.send(new SendTaskSuccessCommand({ taskToken: m.Attributes.taskToken, output: '{}' }));
    }
  } catch (e) {
    console.error('lifecycle_notify_failed', e.name);
  }

  return reply(200, { ct: item.ct, iv: item.iv, usesLeft: item.usesLeft, maxUses: item.maxUses });
};
