import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const lambda = new LambdaClient({});
const TableName = process.env.TABLE;
const reply = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// Solo lectura: no consume usos y nunca devuelve el texto cifrado
async function info(id) {
  const now = Math.floor(Date.now() / 1000);
  const { Item } = await ddb.send(new GetCommand({ TableName, Key: { pk: `SEC#${id}` }, ConsistentRead: true }));
  if (!Item || Item.expiresAt <= now || Item.usesLeft <= 0) return reply(404, { error: 'not_found_or_used' });
  return reply(200, {
    usesLeft: Item.usesLeft, maxUses: Item.maxUses, expiresAt: Item.expiresAt,
    pass: Item.pass === true, caseRef: Item.caseRef ?? null,
  });
}

export const handler = async (event) => {
  const id = event.pathParameters?.id ?? '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return reply(404, { error: 'not_found_or_used' });
  if (event.requestContext?.http?.method === 'GET') return info(id);

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

  // Registrar la lectura (contador e historial) y, si fue la última, despertar a Step Functions.
  // Si fue la primera en un link multi-uso, avisar al emisor sin esperar al último uso.
  // Un fallo aquí nunca debe impedir la entrega del secreto.
  try {
    const m = await ddb.send(new UpdateCommand({
      TableName, Key: { pk: `META#${id}` },
      UpdateExpression: 'ADD #r :one SET lastReadAt = :now, readLog = list_append(if_not_exists(readLog, :empty), :t)',
      ExpressionAttributeNames: { '#r': 'reads' },
      ExpressionAttributeValues: { ':one': 1, ':now': now, ':empty': [], ':t': [now] },
      ReturnValues: 'ALL_NEW',
    }));
    const meta = m.Attributes;
    if (item.usesLeft === 0 && meta?.taskToken) {
      await sfn.send(new SendTaskSuccessCommand({ taskToken: meta.taskToken, output: '{}' }));
    } else if ((meta?.reads ?? 0) === 1 && (meta?.maxUses ?? 1) > 1 && meta?.notifyEmail && process.env.LIFECYCLE_FN) {
      // Primer acceso en link multi-uso con seguimiento: avisar al emisor ahora, sin consumir el token de Step Functions
      await lambda.send(new InvokeCommand({
        FunctionName: process.env.LIFECYCLE_FN,
        InvocationType: 'Event', // asíncrono; no bloquea la respuesta al receptor
        Payload: JSON.stringify({ action: 'notifyFirstRead', id }),
      })).catch((e) => console.error('first_read_notify_failed', e.name));
    }
  } catch (e) {
    console.error('lifecycle_notify_failed', e.name);
  }

  return reply(200, {
    ct: item.ct, iv: item.iv, usesLeft: item.usesLeft, maxUses: item.maxUses,
    pass: item.pass === true, caseRef: item.caseRef ?? null,
  });
};
