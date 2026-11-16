// Formulario de creación (index.html) en un Chrome real contra la API simulada.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, wait, typeSecret } from '../helpers/browser.mjs';

const ctx = await launch();
after(() => ctx?.close());
const skip = ctx ? false : 'Chrome no encontrado: instala Chrome/Chromium o define CHROME_PATH';

const LINK = /^http:\/\/localhost:\d+\/reveal\.html#[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/;
const crear = async (page) => { await page.click('#go'); await page.waitForSelector('#result:not([hidden])'); };
const rot = (page) => page.evaluate(() => ({
  oculto: document.querySelector('#notifyBox').hidden,
  marcada: document.querySelector('#rotate').checked,
  etiqueta: document.querySelector('#rotateLabel').textContent,
  ayuda: document.querySelector('#rotateHint').textContent,
}));
const resultado = (page) => page.evaluate(() => ({
  chips: [...document.querySelectorAll('#resultChips li')].map((l) => l.textContent),
  ayuda: document.querySelector('#resultHint').textContent,
}));

describe('formulario: controles', { skip }, () => {
  it('caducidad y usos son controles segmentados que cambian el valor con clic y con teclado', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#ttl + .seg .seg-opt:nth-child(5)');
    assert.equal(await page.$eval('#ttl', (e) => e.value), '604800');
    await page.focus('#uses + .seg .seg-opt.on');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.$eval('#uses', (e) => e.value), '3');
    await page.close();
  });

  it('una credencial de larga duración fija la caducidad en 1 h y el control lo refleja', async () => {
    const page = await ctx.open('/index.html');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(await page.$eval('#ttl', (e) => e.value), '3600');
    assert.equal(await page.$eval('#ttl + .seg .on', (e) => e.textContent), '1 h');
    assert.match(await page.$eval('#detect', (e) => e.textContent), /access key de AWS/);
    await page.close();
  });

  it('si el usuario elige la caducidad a mano, la detección no la pisa', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#ttl + .seg .seg-opt:nth-child(2)');       // 5 min
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(await page.$eval('#ttl', (e) => e.value), '300');
    await page.close();
  });

  it('passphrase de menos de 12 caracteres: abre "Más opciones", enfoca el campo y explica el error', async () => {
    const page = await ctx.open('/index.html');
    await page.type('#secret', 'algo');
    await page.click('.adv summary'); await page.type('#pass', 'corta'); await page.click('.adv summary');   // abrir, escribir, cerrar
    await page.click('#go');
    await wait(200);
    assert.equal(await page.$eval('#error', (e) => e.textContent), 'La passphrase debe tener al menos 12 caracteres.');
    assert.equal(await page.$eval('.adv', (e) => e.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pass');
    await page.close();
  });

  it('sin texto, pide escribir un secreto', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#go');
    assert.equal(await page.$eval('#error', (e) => e.textContent), 'Escribe un secreto primero.');
    await page.close();
  });

  it('mientras se crea, el botón muestra "Cifrando…" con el avión animado y queda deshabilitado', async () => {
    const page = await ctx.open('/index.html');
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.method() === 'POST' && r.url().includes('/api/secrets') ? setTimeout(() => r.continue(), 800) : r.continue()));
    await page.type('#secret', 'algo');
    await page.click('#go');
    await wait(400);
    assert.deepEqual(await page.$eval('#go', (b) => ({ texto: b.textContent, cargando: b.classList.contains('loading'), deshabilitado: b.disabled })),
      { texto: 'Cifrando…', cargando: true, deshabilitado: true });
    await page.waitForSelector('#result:not([hidden])');
    assert.deepEqual(await page.$eval('#go', (b) => ({ texto: b.textContent, cargando: b.classList.contains('loading'), deshabilitado: b.disabled })),
      { texto: 'Crear link', cargando: false, deshabilitado: false });
    await page.close();
  });
});

describe('formulario: resultado y privacidad', { skip }, () => {
  it('muestra el link, el resumen y el botón de copiar confirma "¡Copiado!"', async () => {
    const page = await ctx.open('/index.html');
    await page.type('#secret', 'mi-secreto');
    await crear(page);
    const link = await page.$eval('#link', (e) => e.value);
    assert.match(link, LINK);
    assert.deepEqual((await resultado(page)).chips, ['Funciona 1 vez', 'Expira en 24 horas']);
    await page.click('#copyLink');
    await wait(150);
    assert.equal(await page.$eval('#copyLink', (b) => b.textContent), '¡Copiado!');
    await wait(2000);
    assert.equal(await page.$eval('#copyLink', (b) => b.textContent), 'Copiar link');   // vuelve a su texto
    await page.close();
  });

  it('el servidor recibe solo texto cifrado: ni el secreto ni la clave del link viajan', async () => {
    const page = await ctx.open('/index.html');
    const secreto = 'texto-que-jamas-debe-llegar-al-servidor-12345';
    await page.type('#secret', secreto);
    await crear(page);
    const clave = (await page.$eval('#link', (e) => e.value)).split(':').pop();
    const enviado = JSON.stringify(await ctx.api.lastCreate());
    assert.ok(!enviado.includes(secreto), 'el secreto en claro llegó al servidor');
    assert.ok(!enviado.includes(clave), 'la clave del link llegó al servidor');
    const { ct, iv } = await ctx.api.lastCreate();
    assert.match(ct, /^[A-Za-z0-9_-]+$/);
    assert.equal(iv.length, 16);                                  // 12 bytes en base64url
    await page.close();
  });

  it('tras crear, el campo del secreto y la passphrase se vacían', async () => {
    const page = await ctx.open('/index.html');
    await page.type('#secret', 'algo');
    await page.click('.adv summary'); await page.type('#pass', 'una-frase-larga-123');
    await crear(page);
    assert.equal(await page.$eval('#secret', (e) => e.value), '');
    assert.equal(await page.$eval('#pass', (e) => e.value), '');
    assert.equal((await ctx.api.lastCreate()).pass, true);
    await page.close();
  });

  it('el avión cruza la pantalla al crear y desaparece al terminar', async () => {
    const page = await ctx.open('/index.html');
    await page.type('#secret', 'algo');
    await crear(page);
    await wait(300);
    assert.equal(await page.$eval('#flyPlane', (e) => e.hidden), false);
    await page.waitForFunction(() => document.querySelector('#flyPlane').hidden, { timeout: 6000 });
    await page.close();
  });

  it('con movimiento reducido el avión no aparece', async () => {
    const page = await ctx.open('/index.html', { reducedMotion: true });
    await page.type('#secret', 'algo');
    await crear(page);
    await wait(400);
    assert.equal(await page.$eval('#flyPlane', (e) => e.hidden), true);
    await page.close();
  });
});

describe('formulario: seguimiento y rotación', { skip }, () => {
  it('textos nuevos: el seguimiento es una opción y la rotación otra, dentro de él', async () => {
    const page = await ctx.open('/index.html');
    assert.match(await page.$eval('label.check', (l) => l.textContent), /Quiero dar seguimiento a este secreto \(avisos por email\)/);
    assert.equal((await rot(page)).oculto, true);
    await page.click('#notify');
    const s = await rot(page);
    assert.equal(s.oculto, false);
    assert.equal(s.marcada, false);
    assert.equal(s.etiqueta, 'Es una credencial que debo rotar');       // sin texto aún: decisión manual
    await page.close();
  });

  it('un tipo rotable se marca solo y nombra lo detectado', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    const s = await rot(page);
    assert.equal(s.marcada, true);
    assert.equal(s.etiqueta, 'Recordarme rotar esta credencial');
    assert.match(s.ayuda, /Detectamos access key de AWS/);
    await page.close();
  });

  it('si el usuario la desmarca, seguir escribiendo no la vuelve a marcar; se envía rotate=false sin keyId', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    await page.click('#rotate');
    await page.type('#secret', ' más texto');
    assert.equal((await rot(page)).marcada, false);
    await page.type('#email', 'yo@correo.com');
    await crear(page);
    const { notify } = await ctx.api.lastCreate();
    assert.equal(notify.rotate, false);
    assert.equal(notify.keyId, undefined, 'la ID de la key solo sirve para el checklist de rotación');
    const r = await resultado(page);
    assert.ok(r.chips.includes('Seguimiento por email'));
    assert.ok(!r.chips.some((c) => /rotación/.test(c)));
    assert.equal(r.ayuda, 'Recibirás un aviso por email cuando se lea o expire.');
    await page.close();
  });

  it('con un tipo rotable y sin tocar nada se envía rotate=true con el tipo y la ID de la key', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    await page.type('#email', 'yo@correo.com');
    await crear(page);
    const { notify } = await ctx.api.lastCreate();
    assert.deepEqual(notify, { email: 'yo@correo.com', credClass: 'aws-access-key', rotate: true, keyId: 'AKIAIOSFODNN7EXAMPLE' });
    const r = await resultado(page);
    assert.ok(r.chips.includes('Con recordatorio de rotación'));
    assert.match(r.ayuda, /checklist de rotación y recordatorios/);
    await page.close();
  });

  it('GitHub: se marca sola y envía credClass=github-token', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', `ghp_${'aB3dE5gH7j'.repeat(4).slice(0, 36)}`);
    assert.match((await rot(page)).ayuda, /token de GitHub/);
    await page.type('#email', 'yo@correo.com');
    await crear(page);
    assert.equal((await ctx.api.lastCreate()).notify.credClass, 'github-token');
    await page.close();
  });

  it('credencial temporal de AWS: reconocida, pero no se marca porque expira sola', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'ASIAIOSFODNN7EXAMPLE token');
    const s = await rot(page);
    assert.equal(s.marcada, false);
    assert.match(s.ayuda, /expira sola/);
    await page.close();
  });

  it('texto no reconocido: decisión manual; si la marca, rotate=true con credClass=generic', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'una-clave-cualquiera-que-no-se-reconoce');
    const s = await rot(page);
    assert.equal(s.marcada, false);
    assert.equal(s.etiqueta, 'Es una credencial que debo rotar');
    assert.match(s.ayuda, /^No reconocimos/);
    await page.click('#rotate');
    await page.type('#email', 'yo@correo.com');
    await crear(page);
    const { notify } = await ctx.api.lastCreate();
    assert.equal(notify.rotate, true);
    assert.equal(notify.credClass, 'generic');
    await page.close();
  });

  it('después de crear, la casilla vuelve a su comportamiento automático', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    await page.click('#rotate');                                   // el usuario la desmarca
    await page.type('#email', 'yo@correo.com');
    await crear(page);
    await typeSecret(page, `ghp_${'aB3dE5gH7j'.repeat(4).slice(0, 36)}`);
    assert.equal((await rot(page)).marcada, true);
    await page.close();
  });

  it('sin seguimiento no se envía notify y el resultado lo dice con claridad', async () => {
    const page = await ctx.open('/index.html');
    await page.type('#secret', 'otra clave');
    await crear(page);
    assert.equal((await ctx.api.lastCreate()).notify, undefined);
    const r = await resultado(page);
    assert.match(r.ayuda, /Sin seguimiento por email/);
    assert.ok(!r.chips.some((c) => /Seguimiento|rotación/.test(c)));
    await page.close();
  });

  it('email inválido: lo señala antes de enviar nada', async () => {
    const page = await ctx.open('/index.html');
    await page.click('#notify');
    await page.type('#secret', 'algo');
    await page.type('#email', 'no-es-un-email');
    await page.click('#go');
    await wait(200);
    assert.equal(await page.$eval('#error', (e) => e.textContent), 'Escribe un email válido para los avisos.');
    await page.close();
  });
});

describe('formulario: salud', { skip }, () => {
  it('sin errores de consola, de CSP ni recursos caídos', () => {
    assert.deepEqual(ctx.problems, []);
  });
});
