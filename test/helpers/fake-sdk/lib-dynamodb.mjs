// DynamoDB en memoria con un intérprete mínimo de las expresiones que usan los handlers de Cirrus:
//   UpdateExpression:    SET a = :v | SET a = a - :v | SET a = list_append(if_not_exists(a, :e), :v) | ADD a :v
//   ConditionExpression: attribute_exists(x) | a > :v | a = :v   (unidas con AND)
// Si un handler empieza a usar otra expresión, el simulador falla con un mensaje claro
// (no la ignora en silencio): hay que ampliarlo aquí.
export const store = new Map();   // pk -> item
const clone = (x) => (x === undefined ? undefined : structuredClone(x));

class Command { constructor(input) { this.input = input; } }
export class GetCommand extends Command {}
export class UpdateCommand extends Command {}
export class DeleteCommand extends Command {}
export class TransactWriteCommand extends Command {}

class ConditionalCheckFailedException extends Error {
  constructor() { super('The conditional request failed'); this.name = 'ConditionalCheckFailedException'; }
}

// Divide por comas que no estén dentro de paréntesis
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function conditionHolds(expr, item, names, values) {
  if (!expr) return true;
  return expr.split(/\s+AND\s+/).every((c) => {
    let m;
    if ((m = c.match(/^attribute_exists\((\w+)\)$/))) return item !== undefined;
    if ((m = c.match(/^(#?\w+)\s*(>|=)\s*(:\w+)$/))) {
      if (!item) return false;
      const v = item[names[m[1]] ?? m[1]];
      return m[2] === '>' ? v > values[m[3]] : v === values[m[3]];
    }
    throw new Error(`Condición no soportada por el simulador: ${c}`);
  });
}

function applyUpdate(item, expr, names, values) {
  const key = (t) => names[t] ?? t;
  for (const [, verb, body] of expr.matchAll(/(SET|ADD)\s+(.+?)(?=\s+(?:SET|ADD)\s|$)/g)) {
    for (const part of splitTop(body)) {
      let m;
      if (verb === 'ADD') {
        if (!(m = part.match(/^(#?\w+)\s+(:\w+)$/))) throw new Error(`ADD no soportado: ${part}`);
        item[key(m[1])] = (item[key(m[1])] ?? 0) + values[m[2]];
        continue;
      }
      if (!(m = part.match(/^(#?\w+)\s*=\s*(.+)$/))) throw new Error(`SET no soportado: ${part}`);
      const [, lhs, rhs] = m; let r;
      if ((r = rhs.match(/^(:\w+)$/))) item[key(lhs)] = values[r[1]];
      else if ((r = rhs.match(/^(#?\w+)\s*-\s*(:\w+)$/))) item[key(lhs)] = item[key(r[1])] - values[r[2]];
      else if ((r = rhs.match(/^list_append\(if_not_exists\((#?\w+),\s*(:\w+)\),\s*(:\w+)\)$/))) item[key(lhs)] = [...(item[key(r[1])] ?? values[r[2]]), ...values[r[3]]];
      else throw new Error(`Valor de SET no soportado: ${rhs}`);
    }
  }
}

export class DynamoDBDocumentClient {
  static from() { return new DynamoDBDocumentClient(); }

  async send(cmd) {
    const i = cmd.input;
    const names = i.ExpressionAttributeNames ?? {};
    const values = i.ExpressionAttributeValues ?? {};

    if (cmd instanceof GetCommand) return { Item: clone(store.get(i.Key.pk)) };

    if (cmd instanceof DeleteCommand) {
      if (!conditionHolds(i.ConditionExpression, store.get(i.Key.pk), names, values)) throw new ConditionalCheckFailedException();
      store.delete(i.Key.pk);
      return {};
    }

    if (cmd instanceof TransactWriteCommand) {
      for (const t of i.TransactItems) store.set(t.Put.Item.pk, clone(t.Put.Item));
      return {};
    }

    if (cmd instanceof UpdateCommand) {
      let item = store.get(i.Key.pk);
      if (!conditionHolds(i.ConditionExpression, item, names, values)) throw new ConditionalCheckFailedException();
      if (!item) { item = { pk: i.Key.pk }; store.set(i.Key.pk, item); }
      applyUpdate(item, i.UpdateExpression, names, values);
      return i.ReturnValues === 'ALL_NEW' ? { Attributes: clone(item) } : {};
    }

    throw new Error(`Comando no soportado por el simulador: ${cmd.constructor.name}`);
  }
}
