// Página de estado (status.html) y confirmación de rotación (ack.html).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, wait, sinErroresReales } from '../helpers/browser.mjs';

const ctx = await launch();
after(() => ctx?.close());
const skip = ctx ? false : 'Chrome no encontrado: instala Chrome/Chromium o define CHROME_PATH';

const url = (c) => `/status.html#${c.id}:${c.statusToken}`;
const vista = (page) => page.evaluate(() => ({
  titular: document.querySelector('#headline').textContent,
  clase: document.querySelector('#headline').className,
  pasos: [...document.querySelectorAll('.step')].map((s) => `${s.className.replace('step ', '')}:${s.querySelector('.label').textContent}`),
  filas: [...document.querySelectorAll('#stat dt')].map((x) => x.textContent),
  enVivo: document.querySelector('#live').hidden ? null : !document.querySelector('#live').classList.contains('off'),
}));
const pasos = (...p) => p;

describe('estado: con seguimiento y rotación', { skip }, () => {
  it('recién creado: espera la lectura', async () => {
    const c = await ctx.api.create({ maxUses: 3, notify: { email: 'a@b.co', rotate: true }, caseRef: 'CASE-9' });
    const page = await ctx.open(url(c));
    const v = await vista(page);
    assert.equal(v.titular, 'Creado, todavía nadie lo ha leído.');
    assert.deepEqual(v.pasos, pasos('done:Creado', 'current:Leído', 'pending:Rotado'));
    assert.ok(v.filas.includes('Referencia') && v.filas.includes('Recordatorios'));
    assert.equal(v.enVivo, true);
    await page.close();
  });

  it('se actualiza solo (sin recargar) cuando alguien lee el secreto', async () => {
    const c = await ctx.api.create({ maxUses: 3, notify: { email: 'a@b.co', rotate: true } });
    const page = await ctx.open(url(c));
    await ctx.api.reveal(c.id);
    await page.waitForFunction(() => /En uso: 1 de 3/.test(document.querySelector('#headline').textContent), { timeout: 9000 });
    assert.deepEqual((await vista(page)).pasos, pasos('done:Creado', 'current:Leído', 'pending:Rotado'));
    await page.close();
  });

  it('leído por completo: rotación pendiente, paso Rotado en curso y sigue sondeando', async () => {
    const c = await ctx.api.create({ maxUses: 1, notify: { email: 'a@b.co', rotate: true } });
    await ctx.api.reveal(c.id);
    const page = await ctx.open(url(c));
    const v = await vista(page);
    assert.equal(v.titular, 'Leído por completo. Rotación pendiente de confirmación.');
    assert.equal(v.clase, 'err');
    assert.deepEqual(v.pasos, pasos('done:Creado', 'done:Leído', 'current:Rotado'));
    assert.ok(v.filas.includes('Recordatorios'));
    assert.equal(v.enVivo, true);
    await page.close();
  });

  it('rotación confirmada: todo en verde y deja de sondear', async () => {
    const c = await ctx.api.create({ maxUses: 1, notify: { email: 'a@b.co', rotate: true } });
    await ctx.api.reveal(c.id);
    const ack = await ctx.open(`/ack.html#${c.id}:token`);
    await ack.click('#ack');
    await ack.waitForFunction(() => !document.querySelector('#msg').hidden);
    await ack.close();
    const page = await ctx.open(url(c));
    const v = await vista(page);
    assert.equal(v.titular, 'Rotación confirmada. Ciclo cerrado.');
    assert.equal(v.clase, 'ok');
    assert.deepEqual(v.pasos, pasos('done:Creado', 'done:Leído', 'done:Rotado'));
    assert.equal(v.enVivo, false);
    await page.close();
  });
});

describe('estado: con seguimiento pero sin rotación', { skip }, () => {
  it('leído por completo: no habla de rotación, avisa del email y cierra', async () => {
    const c = await ctx.api.create({ maxUses: 1, notify: { email: 'a@b.co', rotate: false } });
    await ctx.api.reveal(c.id);
    const page = await ctx.open(url(c), { width: 390, height: 800 });
    const v = await vista(page);
    assert.equal(v.titular, 'Leído por completo. Te avisamos por email.');
    assert.equal(v.clase, 'hint');
    assert.deepEqual(v.pasos, pasos('done:Creado', 'done:Leído', 'done:Cerrado'));
    assert.ok(!v.filas.includes('Recordatorios'));
    assert.equal(v.enVivo, false);
    await page.close();
  });

  it('expirado sin leer: cierra', async () => {
    const c = await ctx.api.create({ ttlSeconds: 1, notify: { email: 'a@b.co', rotate: false } });
    await wait(1500);
    const page = await ctx.open(url(c));
    const v = await vista(page);
    assert.equal(v.titular, 'Expiró sin que nadie lo leyera.');
    assert.deepEqual(v.pasos, pasos('done:Creado', 'warn:Sin leer', 'done:Cerrado'));
    assert.equal(v.enVivo, false);
    await page.close();
  });

  it('expirado con lecturas: informa las lecturas y que se avisó por email', async () => {
    const c = await ctx.api.create({ ttlSeconds: 2, maxUses: 3, notify: { email: 'a@b.co', rotate: false } });
    await ctx.api.reveal(c.id);
    await wait(2500);
    const page = await ctx.open(url(c));
    assert.equal((await vista(page)).titular, 'Expiró y se leyó 1 de 3 veces. Te avisamos por email.');
    await page.close();
  });
});

describe('estado: sin seguimiento', { skip }, () => {
  it('leído por completo: no hay seguimiento activo y el sondeo se detiene (el servidor no actualiza su estado)', async () => {
    const c = await ctx.api.create({ maxUses: 1 });
    await ctx.api.reveal(c.id);
    const page = await ctx.open(url(c));
    const v = await vista(page);
    assert.equal(v.titular, 'Leído por completo. No hay seguimiento activo.');
    assert.deepEqual(v.pasos, pasos('done:Creado', 'done:Leído', 'done:Cerrado'));
    assert.equal(v.enVivo, false);
    await page.close();
  });

  it('un link de estado inválido o incompleto lo dice', async () => {
    const mal = await ctx.open('/status.html#AAAAAAAAAAAAAAAAAAAAAA:token-malo');
    assert.equal((await vista(mal)).titular, 'No se encontró este secreto o el link es inválido.');
    await mal.close();
    const vacio = await ctx.open('/status.html');
    assert.equal((await vista(vacio)).titular, 'Este link está incompleto.');
    await vacio.close();
  });

  it('la página de estado no muestra nunca el contenido ni el email', async () => {
    const c = await ctx.api.create({ maxUses: 1, notify: { email: 'privado@correo.com', rotate: true } });
    const page = await ctx.open(url(c));
    const texto = await page.$eval('main', (m) => m.textContent);
    assert.ok(!texto.includes('privado@correo.com'));
    assert.ok(!texto.includes('AAAA'));
    await page.close();
  });
});

describe('ack: confirmar la rotación', { skip }, () => {
  it('el botón confirma, muestra el éxito y despega el avión', async () => {
    const c = await ctx.api.create({ notify: { email: 'a@b.co', rotate: true } });
    const page = await ctx.open(`/ack.html#${c.id}:token`);
    assert.equal(await page.$eval('#ack', (b) => b.hidden), false);
    await page.click('#ack');
    await page.waitForFunction(() => !document.querySelector('#msg').hidden);
    assert.deepEqual(await page.evaluate(() => ({
      boton: document.querySelector('#ack').hidden,
      mensaje: document.querySelector('#msg').textContent,
      clase: document.querySelector('#msg').className,
      avion: document.querySelector('#takeoffPlane').hidden,
    })), { boton: true, mensaje: 'Listo, rotación confirmada. No enviaremos más recordatorios.', clase: 'ok check-line', avion: false });
    await page.waitForFunction(() => document.querySelector('#takeoffPlane').hidden, { timeout: 5000 });
    await page.close();
  });

  it('nada se confirma al solo abrir el link (un escáner de correo no debe confirmar por el usuario)', async () => {
    const c = await ctx.api.create({ notify: { email: 'a@b.co', rotate: true } });
    const page = await ctx.open(`/ack.html#${c.id}:token`);
    await page.close();
    const estado = await ctx.open(url(c));
    assert.notEqual((await vista(estado)).titular, 'Rotación confirmada. Ciclo cerrado.');
    await estado.close();
  });

  it('un link incompleto se declara así y no ofrece confirmar', async () => {
    const page = await ctx.open('/ack.html');
    assert.equal(await page.$eval('#ack', (b) => b.hidden), true);
    assert.equal(await page.$eval('#msg', (m) => m.textContent), 'Este link está incompleto.');
    await page.close();
  });

  it('un secreto que no existe: error claro y el botón se puede reintentar', async () => {
    const page = await ctx.open('/ack.html#AAAAAAAAAAAAAAAAAAAAAA:token');
    await page.click('#ack');
    await page.waitForFunction(() => !document.querySelector('#msg').hidden);
    assert.equal(await page.$eval('#msg', (m) => m.textContent), 'No se pudo confirmar (link inválido o vencido).');
    assert.equal(await page.$eval('#msg', (m) => m.getAttribute('role')), 'alert');
    assert.equal(await page.$eval('#ack', (b) => b.disabled), false);
    await page.close();
  });
});

describe('estado y ack: salud', { skip }, () => {
  it('sin errores de consola ni de CSP (los 404 esperados se ignoran)', () => {
    assert.deepEqual(sinErroresReales(ctx.problems), []);
  });
});
