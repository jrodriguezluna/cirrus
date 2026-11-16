// Handlers reales de src/ (create, reveal, ack, status, lifecycle) contra un AWS simulado en memoria.
// No toca AWS. Ver test/helpers/fake-sdk/.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import '../helpers/register.mjs';     // sustituye '@aws-sdk/*' por el simulador (debe ir antes de importar los handlers)

process.env.TABLE = 'tabla-de-prueba';
process.env.STATE_MACHINE = 'arn:sm-de-prueba';
process.env.SENDER = 'cirrus@demo.test';
process.env.SITE_URL = 'https://site.test';
process.env.REMINDER_WAIT = '30';
process.env.LIFECYCLE_FN = 'arn:lifecycle-de-prueba';

const { store } = await import('../helpers/fake-sdk/lib-dynamodb.mjs');
const { sent } = await import('../helpers/fake-sdk/client-sesv2.mjs');
const { started, succeeded } = await import('../helpers/fake-sdk/client-sfn.mjs');
const { invoked } = await import('../helpers/fake-sdk/client-lambda.mjs');
const create = (await import('../../src/create/index.mjs')).handler;
const reveal = (await import('../../src/reveal/index.mjs')).handler;
const ack = (await import('../../src/ack/index.mjs')).handler;
const status = (await import('../../src/status/index.mjs')).handler;
const lifecycle = (await import('../../src/lifecycle/index.mjs')).handler;

const AKIA = 'AKIAIOSFODNN7EXAMPLE';
const HEX40 = 'b'.repeat(40);

// ---------- ayudantes
async function make(extra = {}, notify) {
  const body = { ct: 'AAAA', iv: 'BBBB', ttlSeconds: 3600, maxUses: 3, ...extra, ...(notify ? { notify } : {}) };
  const r = await create({ body: JSON.stringify(body), requestContext: { domainName: 'api.test' } });
  const b = JSON.parse(r.body);
  return { code: r.statusCode, ...b, meta: store.get(`META#${b.id}`), sec: store.get(`SEC#${b.id}`) };
}
const call = async (fn, event) => { const r = await fn(event); return { code: r.statusCode, body: JSON.parse(r.body) }; };
const doReveal = (id) => call(reveal, { pathParameters: { id }, requestContext: { http: { method: 'POST' } } });
const doInfo = (id) => call(reveal, { pathParameters: { id }, requestContext: { http: { method: 'GET' } } });
const doStatus = (c, token = c.statusToken) => call(status, { pathParameters: { id: c.id }, headers: { 'x-status-token': token } });
const doAck = (id, ackToken) => call(ack, { body: JSON.stringify({ id, ackToken }) });
async function mailFor(action, id, patch = {}) {
  Object.assign(store.get(`META#${id}`), patch);
  sent.length = 0;
  const out = await lifecycle({ action, id });
  return { out, mail: sent[0] };
}

// ================================================================== create
describe('create: seguimiento y rotación', () => {
  it('con rotación: guarda rotate, el tipo y la ID de la key, y la state machine recibe rotate=true', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true });
    assert.equal(c.code, 201);
    assert.equal(c.meta.rotate, true);
    assert.equal(c.meta.credClass, 'aws-access-key');
    assert.equal(c.meta.keyId, AKIA);
    assert.equal(JSON.parse(started.at(-1).input).rotate, true);
  });

  it('sin rotación: conserva el email pero NO guarda tipo, keyId ni account', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: false });
    assert.equal(c.code, 201);
    assert.equal(c.meta.rotate, false);
    assert.equal(c.meta.notifyEmail, 'a@b.co');
    assert.equal(c.meta.credClass, undefined);
    assert.equal(c.meta.keyId, undefined);
    assert.equal(c.meta.account, undefined);
    assert.equal(JSON.parse(started.at(-1).input).rotate, false);
  });

  it('un cliente anterior (sin rotate) se interpreta como con rotación', async () => {
    const c = await make({}, { email: 'a@b.co' });
    assert.equal(c.code, 201);
    assert.equal(c.meta.rotate, true);
    assert.equal(JSON.parse(started.at(-1).input).rotate, true);
  });

  it('sin seguimiento: no hay email, ni rotate, ni ejecución de la state machine', async () => {
    const antes = started.length;
    const c = await make();
    assert.equal(c.code, 201);
    assert.equal(c.meta.notifyEmail, undefined);
    assert.equal(c.meta.rotate, undefined);
    assert.equal(started.length, antes);
  });

  it('rotate con un tipo inválido: 400 invalid_rotate y no escribe nada', async () => {
    const n = store.size;
    const c = await make({}, { email: 'a@b.co', rotate: 'si' });
    assert.equal(c.code, 400);
    assert.equal(c.error, 'invalid_rotate');
    assert.equal(store.size, n);
  });
});

describe('create: validación de entrada', () => {
  const casos = [
    ['JSON inválido', { raw: '{no es json' }, 'invalid_json'],
    ['ct con caracteres no base64url', { ct: 'no es base64!' }, 'invalid_ct'],
    ['iv ausente', { iv: undefined }, 'invalid_iv'],
    ['TTL menor al mínimo', { ttlSeconds: 59 }, 'invalid_ttl'],
    ['TTL mayor al máximo (7 días)', { ttlSeconds: 604801 }, 'invalid_ttl'],
    ['TTL no entero', { ttlSeconds: 60.5 }, 'invalid_ttl'],
    ['más de 5 usos', { maxUses: 6 }, 'invalid_max_uses'],
    ['0 usos', { maxUses: 0 }, 'invalid_max_uses'],
    ['pass que no es booleano', { pass: 'si' }, 'invalid_pass'],
    ['referencia con caracteres de control', { caseRef: 'a\u0000b' }, 'invalid_ref'],
    ['referencia con <', { caseRef: '<script>' }, 'invalid_ref'],
    ['referencia demasiado larga', { caseRef: 'x'.repeat(81) }, 'invalid_ref'],
  ];
  for (const [nombre, extra, error] of casos) {
    it(`${nombre}: 400 ${error}`, async () => {
      const n = store.size;
      const r = extra.raw !== undefined
        ? await create({ body: extra.raw })
        : await create({ body: JSON.stringify({ ct: 'AAAA', iv: 'BBBB', ttlSeconds: 3600, maxUses: 1, ...extra }) });
      assert.equal(r.statusCode, 400);
      assert.equal(JSON.parse(r.body).error, error);
      assert.equal(store.size, n, 'una petición inválida no debe escribir nada');
    });
  }

  const notifyMalo = [
    ['email inválido', { email: 'no-es-un-email' }, 'invalid_email'],
    ['tipo de credencial desconocido', { email: 'a@b.co', credClass: 'inventado' }, 'invalid_class'],
    ['keyId que no corresponde al tipo', { email: 'a@b.co', credClass: 'aws-access-key', keyId: 'AKIA-corta' }, 'invalid_key_id'],
    ['keyId en un tipo sin ID', { email: 'a@b.co', credClass: 'github-token', keyId: AKIA }, 'invalid_key_id'],
    ['account en un tipo que no es service account de GCP', { email: 'a@b.co', credClass: 'aws-access-key', account: 'x@y.co' }, 'invalid_account'],
  ];
  for (const [nombre, notify, error] of notifyMalo) {
    it(`notify con ${nombre}: 400 ${error}`, async () => {
      const c = await make({}, notify);
      assert.equal(c.code, 400);
      assert.equal(c.error, error);
    });
  }

  it('GCP con keyId y account válidos se acepta', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'gcp-sa', keyId: HEX40, account: 'robot@demo.iam.gserviceaccount.com', rotate: true });
    assert.equal(c.code, 201);
    assert.equal(c.meta.account, 'robot@demo.iam.gserviceaccount.com');
  });
});

describe('create: qué se guarda', () => {
  it('el token de estado se guarda solo como hash; el secreto cifrado nunca se devuelve', async () => {
    const c = await make({ caseRef: 'CASE-1' });
    assert.equal(c.meta.statusTokenHash, createHash('sha256').update(c.statusToken).digest('hex'));
    assert.ok(!JSON.stringify(c.meta).includes(c.statusToken), 'el statusToken no debe aparecer en claro en META');
    assert.equal(c.ct, undefined);
    assert.equal(c.sec.usesLeft, 3);
    assert.equal(c.sec.ct, 'AAAA');
  });
  it('los ids tienen 22 caracteres base64url (se validan así en reveal/status/ack)', async () => {
    const c = await make();
    assert.match(c.id, /^[A-Za-z0-9_-]{22}$/);
  });
  it('el contenido cifrado y los metadatos viven en items distintos', async () => {
    const c = await make();
    assert.ok(c.sec && c.meta);
    assert.equal(c.meta.ct, undefined);
  });
});

// ================================================================== reveal
describe('reveal: lectura atómica y usos', () => {
  it('info no consume usos y nunca devuelve el contenido cifrado', async () => {
    const c = await make({ maxUses: 2, caseRef: 'REF-9' });
    const i1 = await doInfo(c.id); const i2 = await doInfo(c.id);
    assert.equal(i1.code, 200);
    assert.deepEqual(i1.body, { usesLeft: 2, maxUses: 2, expiresAt: c.sec.expiresAt, pass: false, caseRef: 'REF-9' });
    assert.equal(i2.body.usesLeft, 2);
    assert.equal(i1.body.ct, undefined);
  });

  it('cada lectura descuenta un uso y registra la lectura', async () => {
    const c = await make({ maxUses: 3 });
    const r1 = await doReveal(c.id);
    assert.equal(r1.code, 200);
    assert.equal(r1.body.ct, 'AAAA');
    assert.equal(r1.body.iv, 'BBBB');
    assert.equal(r1.body.usesLeft, 2);
    assert.equal((await doReveal(c.id)).body.usesLeft, 1);
    assert.equal(store.get(`META#${c.id}`).reads, 2);
    assert.equal(store.get(`META#${c.id}`).readLog.length, 2);
  });

  it('el último uso borra el secreto y un intento posterior recibe 404', async () => {
    const c = await make({ maxUses: 1 });
    assert.equal((await doReveal(c.id)).code, 200);
    assert.equal(store.has(`SEC#${c.id}`), false);
    const otra = await doReveal(c.id);
    assert.equal(otra.code, 404);
    assert.equal((await doInfo(c.id)).code, 404);
  });

  it('dos lecturas simultáneas del último uso: solo una recibe el secreto', async () => {
    const c = await make({ maxUses: 1 });
    const [a, b] = await Promise.all([doReveal(c.id), doReveal(c.id)]);
    assert.deepEqual([a.code, b.code].sort(), [200, 404]);
  });

  it('un secreto vencido responde 404 aunque el item siga en la tabla (el TTL de DynamoDB no es fiable)', async () => {
    const c = await make({ maxUses: 2 });
    store.get(`SEC#${c.id}`).expiresAt = Math.floor(Date.now() / 1000) - 1;
    assert.equal((await doReveal(c.id)).code, 404);
    assert.equal((await doInfo(c.id)).code, 404);
  });

  it('ids mal formados responden 404 sin tocar la tabla', async () => {
    for (const id of ['', 'corto', 'x'.repeat(23), 'con espacios 0000000000']) {
      assert.equal((await doReveal(id)).code, 404, id);
    }
  });

  it('el último uso despierta a la state machine con el taskToken registrado', async () => {
    const c = await make({ maxUses: 1 }, { email: 'a@b.co', rotate: true });
    store.get(`META#${c.id}`).taskToken = 'token-de-prueba';
    succeeded.length = 0;
    await doReveal(c.id);
    assert.deepEqual(succeeded.map((s) => s.taskToken), ['token-de-prueba']);
  });
});

describe('reveal: aviso al primer acceso de un link multi-uso', () => {
  it('con seguimiento: la primera lectura invoca notifyFirstRead una sola vez', async () => {
    const c = await make({ maxUses: 3 }, { email: 'a@b.co', rotate: false });
    invoked.length = 0;
    await doReveal(c.id);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].FunctionName, 'arn:lifecycle-de-prueba');
    assert.equal(invoked[0].InvocationType, 'Event');         // asíncrono: no retrasa al receptor
    assert.deepEqual(JSON.parse(invoked[0].Payload), { action: 'notifyFirstRead', id: c.id });
    await doReveal(c.id);
    assert.equal(invoked.length, 1, 'la segunda lectura no debe avisar otra vez');
  });

  it('sin seguimiento: no se invoca ninguna Lambda', async () => {
    const c = await make({ maxUses: 3 });
    invoked.length = 0;
    await doReveal(c.id);
    assert.equal(invoked.length, 0);
  });

  it('con un solo uso: no hay aviso de primer acceso (basta el de lectura completa)', async () => {
    const c = await make({ maxUses: 1 }, { email: 'a@b.co' });
    invoked.length = 0;
    await doReveal(c.id);
    assert.equal(invoked.length, 0);
  });
});

// ================================================================== ack
describe('ack: confirmación de rotación', () => {
  it('con el token correcto marca el secreto como ACKED', async () => {
    const c = await make({}, { email: 'a@b.co' });
    const r = await doAck(c.id, c.meta.ackToken);
    assert.equal(r.code, 200);
    assert.equal(store.get(`META#${c.id}`).status, 'ACKED');
  });
  it('con un token incorrecto responde 404 y no cambia el estado', async () => {
    const c = await make({}, { email: 'a@b.co' });
    assert.equal((await doAck(c.id, 'token-equivocado')).code, 404);
    assert.equal(store.get(`META#${c.id}`).status, 'CREATED');
  });
  it('petición mal formada: 400', async () => {
    assert.equal((await doAck('corto', 'x')).code, 400);
    assert.equal((await call(ack, { body: 'no es json' })).code, 400);
  });
});

// ================================================================== status
describe('status', () => {
  it('con rotación: notify=true y rotate=true', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: true });
    const s = (await doStatus(c)).body;
    assert.equal(s.notify, true);
    assert.equal(s.rotate, true);
  });
  it('sin rotación: notify=true y rotate=false', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: false });
    const s = (await doStatus(c)).body;
    assert.equal(s.notify, true);
    assert.equal(s.rotate, false);
  });
  it('sin seguimiento: notify=false y rotate=false', async () => {
    const c = await make();
    const s = (await doStatus(c)).body;
    assert.equal(s.notify, false);
    assert.equal(s.rotate, false);
  });
  it('registro anterior a la opción (con email, sin rotate): se trata como con rotación', async () => {
    const c = await make({}, { email: 'a@b.co' });
    delete store.get(`META#${c.id}`).rotate;
    assert.equal((await doStatus(c)).body.rotate, true);
  });
  it('nunca devuelve el token de confirmación, su hash ni el contenido cifrado', async () => {
    const c = await make({}, { email: 'a@b.co' });
    const s = (await doStatus(c)).body;
    for (const campo of ['ackToken', 'statusTokenHash', 'ct', 'iv', 'notifyEmail', 'taskToken']) assert.equal(campo in s, false, campo);
  });
  it('un token de estado incorrecto o ausente responde 404', async () => {
    const c = await make();
    assert.equal((await doStatus(c, 'otro-token')).code, 404);
    assert.equal((await doStatus(c, '')).code, 404);
  });
});

// ================================================================== lifecycle
describe('lifecycle: correo al agotar los usos', () => {
  const lecturas = { reads: 3, readLog: [1700000000, 1700000100, 1700000200] };

  it('con rotación: checklist específico, "sigue activa" y link de confirmación', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true });
    const { mail } = await mailFor('notifyRead', c.id, lecturas);
    assert.match(mail.text, /Checklist de rotación/);
    assert.match(mail.text, /SIGUE ACTIVA/);
    assert.match(mail.text, /site\.test\/ack\.html#/);
    assert.ok(mail.text.includes(`aws iam update-access-key`) && mail.text.includes(AKIA));
  });

  it('sin rotación: aviso breve, sin checklist, sin "sigue activa" y sin link de confirmación', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: false });
    const { mail } = await mailFor('notifyRead', c.id, lecturas);
    assert.doesNotMatch(mail.text, /Checklist|SIGUE ACTIVA|ack\.html/);
    assert.match(mail.text, /agotó sus usos/);
    assert.match(mail.text, /Lecturas:/);
    assert.match(mail.subject, /se leyó por completo \(3 de 3\)/);
    assert.equal(mail.to, 'a@b.co');
  });

  it('registro anterior (sin rotate): se comporta como con rotación', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'github-token' });
    delete store.get(`META#${c.id}`).rotate;
    const { mail } = await mailFor('notifyRead', c.id, lecturas);
    assert.match(mail.text, /Checklist de rotación/);
    assert.match(mail.text, /ack\.html#/);
  });

  it('marca el estado como READ', async () => {
    const c = await make({}, { email: 'a@b.co' });
    await mailFor('notifyRead', c.id, lecturas);
    assert.equal(store.get(`META#${c.id}`).status, 'READ');
  });

  it('con referencia: aparece en el asunto y en el cuerpo', async () => {
    const c = await make({ caseRef: 'CASE-77' }, { email: 'a@b.co', rotate: false });
    const { mail } = await mailFor('notifyRead', c.id, lecturas);
    assert.match(mail.subject, /\[CASE-77\]/);
    assert.match(mail.text, /Referencia: CASE-77/);
  });
});

describe('lifecycle: correo al expirar', () => {
  const conLecturas = { reads: 3, readLog: [1700000000, 1700000100, 1700000200] };
  const sinLecturas = { reads: 0, readLog: [] };

  it('con lecturas y rotación: checklist y aviso de exposición', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true });
    const { mail, out } = await mailFor('notifyExpired', c.id, conLecturas);
    assert.match(mail.text, /Checklist de rotación/);
    assert.match(mail.text, /expuesta/);
    assert.equal(out.reads, 3);
  });
  it('con lecturas y sin rotación: solo informa cuántas veces se leyó', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: false });
    const { mail, out } = await mailFor('notifyExpired', c.id, conLecturas);
    assert.doesNotMatch(mail.text, /Checklist|expuesta|ack\.html/);
    assert.match(mail.text, /Se leyó 3 de 3 veces/);
    assert.equal(out.reads, 3);
  });
  it('sin lecturas y sin rotación: no sugiere desactivar nada', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: false });
    const { mail, out } = await mailFor('notifyExpired', c.id, sinLecturas);
    assert.match(mail.text, /expiró sin que nadie lo leyera\.$/);
    assert.doesNotMatch(mail.text, /desactívala/);
    assert.equal(out.reads, 0);
  });
  it('sin lecturas y con rotación: conserva la sugerencia de desactivar', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: true });
    const { mail } = await mailFor('notifyExpired', c.id, sinLecturas);
    assert.match(mail.text, /desactívala igualmente/);
  });
  it('borra el secreto cifrado y marca EXPIRED', async () => {
    const c = await make({}, { email: 'a@b.co' });
    await mailFor('notifyExpired', c.id, sinLecturas);
    assert.equal(store.has(`SEC#${c.id}`), false);
    assert.equal(store.get(`META#${c.id}`).status, 'EXPIRED');
  });
});

describe('lifecycle: primer acceso, recordatorios y cierre', () => {
  it('primer acceso: avisa que se abrió y cuántos usos quedan, sin checklist', async () => {
    const c = await make({ maxUses: 3 }, { email: 'a@b.co', rotate: false });
    const { mail } = await mailFor('notifyFirstRead', c.id, { reads: 1, readLog: [1700000000] });
    assert.match(mail.text, /primera vez/);
    assert.match(mail.text, /Quedan 2 usos de 3/);
    assert.doesNotMatch(mail.text, /Checklist|ack\.html/);
  });
  it('primer acceso sin email: no envía nada', async () => {
    const c = await make({ maxUses: 3 });
    const { mail } = await mailFor('notifyFirstRead', c.id, { reads: 1, readLog: [1700000000] });
    assert.equal(mail, undefined);
  });
  it('recordatorio: incrementa los intentos y reenvía checklist y link', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'github-token', rotate: true });
    const { mail } = await mailFor('sendReminder', c.id);
    assert.equal(store.get(`META#${c.id}`).attempts, 1);
    assert.match(mail.subject, /recordatorio 1 de 3/);
    assert.match(mail.text, /Checklist de rotación/);
    assert.match(mail.text, /ack\.html#/);
  });
  it('checkAck refleja la confirmación y los intentos', async () => {
    const c = await make({}, { email: 'a@b.co' });
    assert.deepEqual((await mailFor('checkAck', c.id)).out, { acked: false, attempts: 0 });
    await doAck(c.id, c.meta.ackToken);
    assert.equal((await mailFor('checkAck', c.id)).out.acked, true);
  });
  it('giveUp marca GAVE_UP y avisa por última vez', async () => {
    const c = await make({}, { email: 'a@b.co' });
    const { mail } = await mailFor('giveUp', c.id);
    assert.equal(store.get(`META#${c.id}`).status, 'GAVE_UP');
    assert.match(mail.subject, /último aviso/);
  });
  it('register: si el secreto ya no existe, despierta a la state machine (carrera entre lectura y registro)', async () => {
    const c = await make({ maxUses: 1 }, { email: 'a@b.co' });
    store.delete(`SEC#${c.id}`);
    succeeded.length = 0;
    await lifecycle({ action: 'register', id: c.id, taskToken: 'tt-1' });
    assert.equal(store.get(`META#${c.id}`).taskToken, 'tt-1');
    assert.deepEqual(succeeded.map((s) => s.taskToken), ['tt-1']);
  });
  it('register: si el secreto sigue disponible, solo guarda el token', async () => {
    const c = await make({ maxUses: 1 }, { email: 'a@b.co' });
    succeeded.length = 0;
    await lifecycle({ action: 'register', id: c.id, taskToken: 'tt-2' });
    assert.equal(succeeded.length, 0);
  });
  it('una acción desconocida falla en voz alta', async () => {
    await assert.rejects(() => lifecycle({ action: 'no-existe', id: 'x' }), /unknown_action/);
  });
  it('sin email de seguimiento: no se envía ningún correo y no falla', async () => {
    const c = await make();
    const { mail } = await mailFor('notifyRead', c.id, { reads: 1, readLog: [1] });
    assert.equal(mail, undefined);
  });
});

describe('lifecycle: checklist de rotación por tipo de credencial', () => {
  const casos = [
    ['aws-access-key', { keyId: AKIA }, [/aws iam update-access-key/, new RegExp(AKIA), /CloudTrail/]],
    ['aws-temp', {}, [/expira sola/]],
    ['gcp-sa', { keyId: HEX40, account: 'robot@demo.iam.gserviceaccount.com' }, [/gcloud iam service-accounts keys disable/, new RegExp(HEX40), /robot@demo\.iam/]],
    ['azure-secret', {}, [/az ad app credential/]],
    ['github-token', {}, [/Developer settings/]],
    ['slack-token', {}, [/api\.slack\.com/]],
    ['pem', {}, [/par de claves/]],
    ['conn-string', {}, [/contraseña del usuario/]],
    ['env', {}, [/\.env/]],
    ['generic', {}, [/Rota o revoca/]],
  ];
  for (const [clase, extra, patrones] of casos) {
    it(`${clase}: el correo trae las instrucciones propias de ese tipo`, async () => {
      const c = await make({}, { email: 'a@b.co', credClass: clase, rotate: true, ...extra });
      assert.equal(c.code, 201, JSON.stringify(c));
      const { mail } = await mailFor('notifyRead', c.id, { reads: 1, readLog: [1] });
      for (const p of patrones) assert.match(mail.text, p);
    });
  }
});
