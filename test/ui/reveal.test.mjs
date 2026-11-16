// Revelar un secreto (reveal.html): se crea con la interfaz real (cifrado de verdad en el navegador)
// y se abre el link generado. Cubre uso único, varios usos, passphrase, expiración y links rotos.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, wait, createViaUi, sinErroresReales } from '../helpers/browser.mjs';

const ctx = await launch();
after(() => ctx?.close());
const skip = ctx ? false : 'Chrome no encontrado: instala Chrome/Chromium o define CHROME_PATH';

const estado = (page) => page.evaluate(() => {
  const $ = (s) => document.querySelector(s);
  return {
    boton: $('#reveal').textContent, botonOculto: $('#reveal').hidden,
    info: $('#info').textContent, puntos: $('#dots').getAttribute('aria-label'),
    mensaje: $('#msg').hidden ? null : $('#msg').textContent, claseMensaje: $('#msg').className,
    secreto: $('#secret').hidden ? null : $('#secret').textContent,
    passphrase: !$('#passBox').hidden, inicio: !$('#homeLink').hidden, acciones: !$('#actions').hidden,
  };
});

describe('reveal: un solo uso, sin passphrase', { skip }, () => {
  it('muestra los usos y la cuenta atrás antes de revelar, sin consumir nada', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await ctx.open(link);
    const e = await estado(page);
    assert.match(e.info, /^Queda 1 uso de 1 · Expira en 23 h 59 min$|^Queda 1 uso de 1 · Expira en 1 d 0 h$/);
    assert.equal(e.puntos, '1 uso disponible de 1');
    assert.equal(e.botonOculto, false);
    assert.equal(e.secreto, null);
    await page.reload({ waitUntil: 'networkidle0' });                       // recargar tampoco gasta el uso
    assert.equal((await estado(page)).puntos, '1 uso disponible de 1');
    await page.close();
  });

  it('descifra en el navegador, avisa que era el último uso y borra el hash de la URL', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await ctx.open(link);
    await page.click('#reveal');
    await page.waitForSelector('#secret:not([hidden])');
    const e = await estado(page);
    assert.equal(e.secreto, 'clave-A-123');
    assert.equal(e.botonOculto, true);
    assert.equal(e.info, 'Quedan 0 usos de 1');
    assert.match(e.mensaje, /Era el último uso: este link ya no funciona/);
    assert.equal(await page.evaluate(() => location.hash), '');             // la clave desaparece de la barra de direcciones
    await page.close();
  });

  it('"Disipar de la pantalla" borra el texto del documento', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await ctx.open(link);
    await page.click('#reveal');
    await page.waitForSelector('#secret:not([hidden])');
    await page.click('#dissolve');
    await page.waitForFunction(() => document.querySelector('#secret').hidden, { timeout: 4000 });
    const e = await estado(page);
    assert.equal(e.secreto, null);
    assert.equal(await page.$eval('#secret', (x) => x.textContent), '');   // no queda en el DOM
    assert.equal(e.acciones, false);
    assert.match(e.mensaje, /se disipó de esta pantalla/);
    await page.close();
  });

  it('con movimiento reducido, disipar es inmediato', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await ctx.open(link, { reducedMotion: true });
    await page.click('#reveal');
    await page.waitForSelector('#secret:not([hidden])');
    await page.click('#dissolve');
    await wait(200);
    assert.equal((await estado(page)).secreto, null);
    await page.close();
  });

  it('copiar da confirmación', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await ctx.open(link);
    await page.click('#reveal');
    await page.waitForSelector('#secret:not([hidden])');
    await page.click('#copy');
    await wait(150);
    assert.equal(await page.$eval('#copy', (b) => b.textContent), '¡Copiado!');
    await page.close();
  });

  it('abrir el link otra vez ya no funciona: no existe, ya se usó o expiró', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await ctx.open(link);
    await page.click('#reveal');
    await page.waitForSelector('#secret:not([hidden])');
    await page.close();
    const otra = await ctx.open(link);                                      // mismo link completo (con la clave)
    const e = await estado(otra);
    assert.equal(e.mensaje, 'Este secreto no existe, ya se usó o expiró.');
    assert.equal(e.claseMensaje, 'err');
    assert.equal(e.botonOculto, true);
    assert.equal(e.inicio, true);
    await otra.close();
  });
});

describe('reveal: varios usos y passphrase', { skip }, () => {
  it('con 3 usos y passphrase: una passphrase incorrecta se puede reintentar sin gastar otro uso', async () => {
    const link = await createViaUi(ctx, { text: 'clave-B-456', uses: 3, pass: 'frase-larga-123' });
    const page = await ctx.open(link, { width: 390, height: 900 });
    let e = await estado(page);
    assert.equal(e.puntos, '3 usos disponibles de 3');
    assert.equal(e.passphrase, true);                                       // ya se sabe que pide passphrase

    await page.click('#reveal');
    await page.waitForFunction(() => document.querySelector('#reveal').textContent === 'Descifrar con passphrase');
    assert.equal((await estado(page)).puntos, '2 usos disponibles de 3');   // el uso se gastó al bajar el bloque cifrado

    await page.type('#pass', 'incorrecta-xxxx');
    await page.click('#reveal');
    await page.waitForFunction(() => /incorrecta/.test(document.querySelector('#msg').textContent), { timeout: 8000 });
    e = await estado(page);
    assert.equal(e.claseMensaje, 'err');
    assert.equal(e.puntos, '2 usos disponibles de 3', 'reintentar no debe gastar otro uso');
    assert.equal(e.secreto, null);
    await page.close();
  });

  it('la passphrase correcta (con Enter y "Mostrar") revela el secreto y deja usos disponibles', async () => {
    const link = await createViaUi(ctx, { text: 'clave-B-456', uses: 3, pass: 'frase-larga-123' });
    const page = await ctx.open(link);
    await page.click('#reveal');
    await page.waitForFunction(() => document.querySelector('#reveal').textContent === 'Descifrar con passphrase');
    await page.click('#showPass');
    assert.equal(await page.$eval('#pass', (e) => e.type), 'text');
    await page.type('#pass', 'frase-larga-123');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#secret:not([hidden])', { timeout: 8000 });
    const e = await estado(page);
    assert.equal(e.secreto, 'clave-B-456');
    assert.match(e.mensaje, /Puedes volver a abrir este link mientras queden usos/);
    assert.equal(e.info, 'Quedan 2 usos de 3');
    assert.equal(await page.evaluate(() => location.hash.length > 1), true, 'con usos restantes el link sigue funcionando');
    await page.close();
  });

  it('al reabrir con usos restantes, se informa el nuevo total', async () => {
    const link = await createViaUi(ctx, { text: 'x', uses: 3 });
    const a = await ctx.open(link);
    await a.click('#reveal'); await a.waitForSelector('#secret:not([hidden])'); await a.close();
    const b = await ctx.open(link);
    assert.match((await estado(b)).info, /^Quedan 2 usos de 3 · Expira en/);
    await b.close();
  });

  it('concordancia en español: "Queda 1 uso" y "Quedan 2 usos"', async () => {
    const link = await createViaUi(ctx, { text: 'x', uses: 2 });
    const a = await ctx.open(link);
    assert.match((await estado(a)).info, /^Quedan 2 usos de 2/);
    await a.click('#reveal'); await a.waitForSelector('#secret:not([hidden])');
    assert.equal((await estado(a)).info, 'Queda 1 uso de 2');
    await a.close();
  });

  it('un link con la clave alterada no descifra y lo explica', async () => {
    const link = await createViaUi(ctx, { text: 'secreto' });
    const [base, hash] = link.split('#');
    const [id, clave] = hash.split(':');
    // Se altera un carácter del medio: el último de una clave de 256 bits en base64url lleva bits de relleno
    const mala = `${clave.slice(0, 10)}${clave[10] === 'A' ? 'B' : 'A'}${clave.slice(11)}`;
    const page = await ctx.open(`${base}#${id}:${mala}`);
    await page.click('#reveal');
    await page.waitForFunction(() => /No se pudo descifrar/.test(document.querySelector('#msg').textContent), { timeout: 8000 });
    assert.equal((await estado(page)).secreto, null);
    await page.close();
  });
});

describe('reveal: expiración y links rotos', { skip }, () => {
  it('si expira mientras la página está abierta, lo avisa y oculta el botón', async () => {
    const c = await ctx.api.create({ ttlSeconds: 3 });
    const page = await ctx.open(`/reveal.html#${c.id}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    assert.match((await estado(page)).info, /Expira en [123] s/);
    await page.waitForFunction(() => /expiró/.test(document.querySelector('#msg').textContent), { timeout: 6000 });
    const e = await estado(page);
    assert.equal(e.mensaje, 'Este secreto expiró.');
    assert.equal(e.botonOculto, true);
    assert.equal(e.inicio, true);
    await page.close();
  });

  it('un link sin id o sin clave se declara incompleto', async () => {
    for (const url of ['/reveal.html', '/reveal.html#soloid']) {
      const page = await ctx.open(url);
      const e = await estado(page);
      assert.equal(e.mensaje, 'Este link está incompleto.', url);
      assert.equal(e.botonOculto, true);
      await page.close();
    }
  });

  it('un id que no existe responde "no existe, ya se usó o expiró"', async () => {
    const page = await ctx.open('/reveal.html#AAAAAAAAAAAAAAAAAAAAAA:clave');
    assert.equal((await estado(page)).mensaje, 'Este secreto no existe, ya se usó o expiró.');
    await page.close();
  });
});

describe('reveal: salud', { skip }, () => {
  it('sin errores de consola ni de CSP (los 404 de secretos ya usados son esperados)', () => {
    assert.deepEqual(sinErroresReales(ctx.problems), []);
  });
});
