// Genera los correos reales de Cirrus como archivos HTML para verlos en el navegador, sin enviar nada.
//
//   npm run preview:emails      ->  tmp/emails/*.html   (la carpeta tmp/ no se versiona)
//
// Usa los mismos handlers y el mismo renderizador que producción (con el AWS simulado de las pruebas).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import './register.mjs';

process.env.TABLE = 'preview'; process.env.STATE_MACHINE = 'arn:preview'; process.env.SENDER = 'cirrus@ejemplo.com';
process.env.SITE_URL = process.env.SITE_URL ?? 'https://d1kfzkgi1y2lh8.cloudfront.net'; process.env.REMINDER_WAIT = '30';

const { store } = await import('./fake-sdk/lib-dynamodb.mjs');
const { sent } = await import('./fake-sdk/client-sesv2.mjs');
const create = (await import('../../src/create/index.mjs')).handler;
const lifecycle = (await import('../../src/lifecycle/index.mjs')).handler;

const out = fileURLToPath(new URL('../../tmp/emails/', import.meta.url));
mkdirSync(out, { recursive: true });

async function nuevo(extra, notify) {
  const r = await create({ body: JSON.stringify({ ct: 'AAAA', iv: 'BBBB', ttlSeconds: 3600, maxUses: 3, ...extra, notify }), requestContext: {} });
  return JSON.parse(r.body).id;
}
const lecturas = { reads: 3, readLog: [1763200000, 1763203600, 1763207200] };
const escenarios = [
  ['1-primer-acceso', { caseRef: 'CASE-12345' }, { credClass: 'aws-access-key', keyId: 'AKIAIOSFODNN7EXAMPLE', rotate: true }, 'notifyFirstRead', { reads: 1, readLog: [1763200000] }],
  ['2-leido-con-rotacion-aws', { caseRef: 'CASE-12345' }, { credClass: 'aws-access-key', keyId: 'AKIAIOSFODNN7EXAMPLE', rotate: true }, 'notifyRead', lecturas],
  ['3-leido-con-rotacion-gcp', {}, { credClass: 'gcp-sa', keyId: 'b'.repeat(40), account: 'robot@proyecto.iam.gserviceaccount.com', rotate: true }, 'notifyRead', lecturas],
  ['4-leido-sin-rotacion', { caseRef: 'Cliente ACME' }, { credClass: 'generic', rotate: false }, 'notifyRead', lecturas],
  ['5-expiro-con-lecturas', {}, { credClass: 'github-token', rotate: true }, 'notifyExpired', { reads: 2, readLog: [1763200000, 1763203600] }],
  ['6-expiro-sin-leer', {}, { credClass: 'generic', rotate: false }, 'notifyExpired', { reads: 0, readLog: [] }],
  ['7-recordatorio', { caseRef: 'CASE-12345' }, { credClass: 'github-token', rotate: true }, 'sendReminder', {}],
  ['8-ultimo-aviso', {}, { credClass: 'github-token', rotate: true }, 'giveUp', {}],
];

for (const [nombre, extra, notify, accion, patch] of escenarios) {
  const id = await nuevo(extra, { email: 'tu@correo.com', ...notify });
  Object.assign(store.get(`META#${id}`), patch);
  sent.length = 0;
  await lifecycle({ action: accion, id });
  const m = sent[0];
  writeFileSync(`${out}${nombre}.html`, m.html);
  writeFileSync(`${out}${nombre}.txt`, `Asunto: ${m.subject}\n\n${m.text}\n`);
  console.log(`${nombre}.html   asunto: ${m.subject}`);
}
console.log(`\nAbre los .html de ${out}`);
