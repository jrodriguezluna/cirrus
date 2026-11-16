// Idioma (es / en) en un Chrome real: interruptor ES | EN, persistencia, detección automática,
// traducción en vivo de los textos dinámicos y del idioma que viaja al backend para los correos.
// Cada prueba abre páginas "aisladas" (contexto nuevo) para que el idioma guardado no contamine a las demás.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launch, wait, createViaUi, sinErroresReales } from '../helpers/browser.mjs';

const ctx = await launch();
after(() => ctx?.close());
const skip = ctx ? false : 'Chrome no encontrado: instala Chrome/Chromium o define CHROME_PATH';
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const abrir = (url, opts = {}) => ctx.open(url, { isolated: true, ...opts });
const texto = (page, sel) => page.$eval(sel, (e) => e.textContent);
const idioma = (page) => page.evaluate(() => document.documentElement.lang);
const elegir = (page, l) => page.click(`.lang-opt[data-lang="${l}"]`);
const guardado = (page) => page.evaluate(() => localStorage.getItem('cirrus.lang'));
const conLang = (link, l) => link.replace(/\.html#/, `.html?lang=${l}#`);
const crear = async (page) => { await page.click('#go'); await page.waitForSelector('#result:not([hidden])'); };
const chips = (page) => page.$$eval('#resultChips li', (l) => l.map((x) => x.textContent));

describe('idioma: interruptor', { skip }, () => {
  it('está en las cuatro páginas, como grupo accesible con ES y EN, y ES activo con el navegador en español', async () => {
    const c = await ctx.api.create({ maxUses: 1, notify: { email: 'a@b.co', rotate: true } });
    for (const url of ['/index.html', `/reveal.html#${c.id}:k`, `/status.html#${c.id}:${c.statusToken}`, `/ack.html#${c.id}:t`]) {
      const page = await abrir(url);
      const g = await page.$eval('.lang-switch', (e) => ({
        rol: e.getAttribute('role'), nombre: e.getAttribute('aria-label'),
        botones: [...e.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-label'), b.getAttribute('aria-pressed'), b.lang]),
      }));
      assert.equal(g.rol, 'group', url);
      assert.equal(g.nombre, 'Idioma', url);
      assert.deepEqual(g.botones, [['ES', 'Español', 'true', 'es'], ['EN', 'English', 'false', 'en']], url);
      assert.equal(await idioma(page), 'es');
      await page.close();
    }
  });

  it('cambiar a EN traduce la página, actualiza <html lang>, el título y los atributos', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    assert.equal(await idioma(page), 'en');
    assert.equal(await texto(page, 'h1'), 'Secrets that dissipate');
    assert.equal(await page.title(), 'Cirrus · secrets that dissipate');
    assert.equal(await texto(page, '#go'), 'Create link');
    assert.equal(await texto(page, 'label[for=secret]'), 'Your secret');
    assert.equal(await page.$eval('#secret', (e) => e.placeholder), 'Paste a credential, a .env file, a private key here…');
    assert.equal(await page.$eval('.brand', (e) => e.getAttribute('aria-label')), 'Cirrus, home');
    assert.equal(await page.$eval('.lang-switch', (e) => e.getAttribute('aria-label')), 'Language');
    assert.equal(await texto(page, '.site-footer p'), 'Built for AWS Builder Center. Secrets are encrypted in your browser: the server never sees them.');
    assert.deepEqual(await page.$$eval('.lang-opt', (b) => b.map((x) => x.getAttribute('aria-pressed'))), ['false', 'true']);
    await elegir(page, 'es');
    assert.equal(await texto(page, 'h1'), 'Secretos que se disipan');
    assert.equal(await idioma(page), 'es');
    await page.close();
  });

  it('los controles segmentados (caducidad y usos) también se traducen', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    assert.equal(await page.$eval('#ttl + .seg', (e) => e.getAttribute('aria-label')), 'Expires in');
    assert.equal(await page.$eval('#uses + .seg', (e) => e.getAttribute('aria-label')), 'Allowed uses');
    assert.equal(await page.$eval('#uses + .seg .seg-opt', (e) => e.textContent), '1');
    assert.equal(await page.$eval('#ttl option[value="60"]', (e) => e.textContent), '1 minute (demo)');
    assert.equal(await page.$eval('#uses option[value="1"]', (e) => e.textContent), '1 (recommended)');
    await page.close();
  });

  it('la elección se guarda y se mantiene al recargar y al cambiar de página', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    assert.equal(await guardado(page), 'en');
    await page.reload({ waitUntil: 'networkidle2' });
    assert.equal(await texto(page, 'h1'), 'Secrets that dissipate');
    assert.equal(await page.$eval('.lang-opt[data-lang="en"]', (e) => e.getAttribute('aria-pressed')), 'true');
    await page.goto(`${ctx.base}/ack.html#AAAAAAAAAAAAAAAAAAAAAA:t`, { waitUntil: 'networkidle2' });
    assert.equal(await texto(page, 'h1'), 'Confirm rotation');
    await page.close();
  });

  it('sin preferencia guardada se usa el idioma del navegador; con ella, la guardada', async () => {
    const en = await abrir('/index.html', { languages: ['en-US', 'en'] });
    assert.equal(await idioma(en), 'en');
    assert.equal(await texto(en, 'h1'), 'Secrets that dissipate');
    assert.equal(await guardado(en), null, 'detectar no guarda nada: solo elegir guarda');
    await en.close();

    const fr = await abrir('/index.html', { languages: ['fr-FR', 'en-GB'] });   // primer idioma soportado de la lista
    assert.equal(await idioma(fr), 'en');
    await fr.close();

    const otro = await abrir('/index.html', { languages: ['fr-FR', 'de'] });    // ninguno soportado: español
    assert.equal(await idioma(otro), 'es');
    await otro.close();

    const elegido = await abrir('/index.html', { languages: ['en-US'] });
    await elegir(elegido, 'es');
    await elegido.reload({ waitUntil: 'networkidle2' });
    assert.equal(await idioma(elegido), 'es', 'lo elegido gana al idioma del navegador');
    await elegido.close();
  });

  it('?lang= (links de los correos) fija el idioma y lo recuerda; un valor inválido se ignora', async () => {
    const page = await abrir('/index.html?lang=en');
    assert.equal(await idioma(page), 'en');
    assert.equal(await guardado(page), 'en');
    await page.close();

    const mal = await abrir('/index.html?lang=fr');
    assert.equal(await idioma(mal), 'es');
    assert.equal(await guardado(mal), null);
    await mal.close();
  });

  it('con el teclado: Tab llega a los dos botones y Enter / Espacio cambian el idioma', async () => {
    const page = await abrir('/index.html');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.lang), 'es');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.lang), 'en');
    await page.keyboard.press('Enter');
    assert.equal(await idioma(page), 'en');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.lang), 'en', 'el foco no se pierde al traducir');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    await page.keyboard.press('Space');
    assert.equal(await idioma(page), 'es');
    await page.close();
  });
});

describe('idioma: formulario de creación', { skip }, () => {
  it('la detección de la credencial y el aviso de rotación se traducen en vivo, sin borrar lo escrito', async () => {
    const page = await abrir('/index.html');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    assert.match(await texto(page, '#detect'), /Parece una access key de AWS de larga duración/);
    assert.match(await texto(page, '#rotateHint'), /^Detectamos access key de AWS\./);
    await elegir(page, 'en');
    assert.match(await texto(page, '#detect'), /Looks like a long-lived AWS access key \(AKIA…\)/);
    assert.match(await texto(page, '#detect'), /Share temporary credentials instead:/);
    assert.equal(await texto(page, '#detect code'), 'aws sts get-session-token --duration-seconds 3600');   // el comando no se traduce
    assert.match(await texto(page, '#rotateHint'), /^Detected: AWS access key\./);
    assert.equal(await texto(page, '#rotateLabel'), 'Remind me to rotate this credential');
    assert.equal(await page.$eval('#secret', (e) => e.value), 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(await page.$eval('#ttl', (e) => e.value), '3600', 'cambiar de idioma no toca la caducidad');
    assert.equal(await page.$eval('#ttl + .seg .on', (e) => e.textContent), '1 h');
    await page.close();
  });

  it('el aviso de varios usos y los errores se traducen, también los ya mostrados', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    await page.click('#go');
    assert.equal(await texto(page, '#error'), 'Enter a secret first.');
    await elegir(page, 'es');
    assert.equal(await texto(page, '#error'), 'Escribe un secreto primero.');
    await elegir(page, 'en');

    await page.type('#secret', 'algo');
    await page.click('.adv summary'); await page.type('#pass', 'corta');
    await page.click('#go');
    assert.equal(await texto(page, '#error'), 'The passphrase must be at least 12 characters long.');
    await page.close();
  });

  it('el resumen del link creado se escribe en el idioma actual y se traduce al cambiarlo', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    await page.type('#secret', 'mi-secreto');
    await crear(page);
    assert.deepEqual(await chips(page), ['Works once', 'Expires in 24 hours']);
    assert.match(await texto(page, '#resultHint'), /^No email follow-up: Cirrus will not notify you/);
    assert.equal(await texto(page, '#statusLink'), 'View this secret’s status');
    assert.equal(await texto(page, '#go'), 'Create link');
    await elegir(page, 'es');
    assert.deepEqual(await chips(page), ['Funciona 1 vez', 'Expira en 24 horas']);
    assert.match(await texto(page, '#resultHint'), /^Sin seguimiento por email/);
    await page.close();
  });

  it('el resumen con varios usos, passphrase y rotación', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    await page.click('#uses + .seg .seg-opt:nth-child(3)');
    await page.click('.adv summary'); await page.type('#pass', 'una-passphrase-larga');
    await page.click('#notify'); await page.type('#email', 'a@b.co');
    await crear(page);
    assert.deepEqual(await chips(page), ['Works 3 times', 'Expires in 1 hour', 'With passphrase', 'Email follow-up', 'With rotation reminder']);
    assert.equal(await texto(page, '#resultHint'), 'Remember to send the passphrase through another channel. You will get a notice when it is read or expires, with the rotation checklist and reminders until you confirm.');
    await elegir(page, 'es');
    assert.equal((await chips(page))[0], 'Funciona 3 veces');
    assert.equal((await chips(page))[1], 'Expira en 1 hora', 'la caducidad del link es la que se envió, no la del formulario');
    await page.close();
  });

  it('el idioma elegido viaja al backend con el seguimiento, para que los correos lleguen en ese idioma', async () => {
    for (const l of ['en', 'es']) {
      const page = await abrir('/index.html');
      await elegir(page, l === 'en' ? 'es' : 'en');       // se cambia de ida y vuelta: manda el idioma vigente al crear
      await elegir(page, l);
      await page.type('#secret', 'algo');
      await page.click('#notify'); await page.type('#email', 'a@b.co');
      await crear(page);
      assert.equal((await ctx.api.lastCreate()).notify.lang, l);
      await page.close();
    }
  });

  it('sin seguimiento no se envía ningún idioma (no hay correos)', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    await page.type('#secret', 'algo');
    await crear(page);
    assert.equal((await ctx.api.lastCreate()).notify, undefined);
    await page.close();
  });

  it('el aviso del email indica el idioma de los correos y cambia con el interruptor', async () => {
    const page = await abrir('/index.html');
    await page.click('#notify');
    assert.equal(await page.$eval('#notifyBox .hint:last-of-type', (e) => e.textContent), 'Los avisos te llegarán en español.');
    await elegir(page, 'en');
    assert.equal(await page.$eval('#notifyBox [data-i18n="index.email.lang"]', (e) => e.textContent), 'Notifications will arrive in English.');
    await page.close();
  });

  it('los botones de copiar confirman en el idioma actual y se restauran en el idioma vigente', async () => {
    const page = await abrir('/index.html');
    await elegir(page, 'en');
    await page.type('#secret', 'algo');
    await crear(page);
    await page.click('#copyLink');
    await wait(150);
    assert.equal(await texto(page, '#copyLink'), 'Copied!');
    await elegir(page, 'es');                               // cambia mientras se muestra el aviso
    assert.equal(await texto(page, '#copyLink'), '¡Copiado!');
    await wait(2000);
    assert.equal(await texto(page, '#copyLink'), 'Copiar link');
    assert.equal(await texto(page, '#copyMail'), 'Copiar como email');
    await page.close();
  });

  it('"Cifrando…" se muestra en el idioma actual mientras se crea y no se pisa al cambiarlo', async () => {
    const page = await abrir('/index.html');
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.method() === 'POST' && r.url().includes('/api/secrets') ? setTimeout(() => r.continue(), 900) : r.continue()));
    await elegir(page, 'en');
    await page.type('#secret', 'algo');
    await page.click('#go');
    await wait(300);
    assert.equal(await texto(page, '#go'), 'Encrypting…');
    await elegir(page, 'es');
    assert.equal(await texto(page, '#go'), 'Cifrando…');
    await page.waitForSelector('#result:not([hidden])');
    assert.equal(await texto(page, '#go'), 'Crear link');
    await page.close();
  });
});

describe('idioma: revelar, estado y confirmación', { skip }, () => {
  it('reveal: antes y después de revelar, en inglés, y se traduce en vivo', async () => {
    const link = await createViaUi(ctx, { text: 'clave-A-123' });
    const page = await abrir(conLang(link, 'en'));
    assert.equal(await texto(page, 'h1'), 'Someone shared a secret with you');
    assert.equal(await texto(page, '#reveal'), 'Reveal secret');
    assert.match(await texto(page, '#info'), /^1 use left of 1 · Expires in (23 h 59 min|1 d 0 h)$/);
    assert.equal(await page.$eval('#dots', (e) => e.getAttribute('aria-label')), '1 use available of 1');
    await elegir(page, 'es');
    assert.match(await texto(page, '#info'), /^Queda 1 uso de 1 · Expira en /);
    assert.equal(await page.$eval('#dots', (e) => e.getAttribute('aria-label')), '1 uso disponible de 1');
    assert.equal(await texto(page, '#reveal'), 'Revelar secreto');
    await elegir(page, 'en');

    await page.click('#reveal');
    await page.waitForSelector('#secret:not([hidden])');
    assert.equal(await texto(page, '#secret'), 'clave-A-123');
    assert.equal(await texto(page, '#info'), '0 uses left of 1');
    assert.match(await texto(page, '#msg'), /^That was the last use: this link no longer works\./);
    assert.equal(await texto(page, '#copy'), 'Copy');
    assert.equal(await texto(page, '#dissolve'), 'Dissipate from the screen');
    await elegir(page, 'es');
    assert.equal(await texto(page, '#info'), 'Quedan 0 usos de 1');
    assert.match(await texto(page, '#msg'), /^Era el último uso/);
    assert.equal(await texto(page, '#secret'), 'clave-A-123', 'traducir no toca el secreto');
    await page.close();
  });

  it('reveal: la referencia del emisor, el link ya usado y el link incompleto', async () => {
    const link = await createViaUi(ctx, { text: 'x' });
    const usado = await abrir(conLang(link, 'en'));
    await usado.click('#reveal');
    await usado.waitForSelector('#secret:not([hidden])');
    await usado.close();
    const otra = await abrir(conLang(link, 'en'));
    assert.equal(await texto(otra, '#msg'), 'This secret does not exist, has already been used or has expired.');
    assert.equal(await texto(otra, '#homeLink'), 'Create my own secret');
    await elegir(otra, 'es');
    assert.equal(await texto(otra, '#msg'), 'Este secreto no existe, ya se usó o expiró.');
    await otra.close();

    const roto = await abrir('/reveal.html?lang=en');
    assert.equal(await texto(roto, '#msg'), 'This link is incomplete.');
    await roto.close();
  });

  it('reveal con passphrase: botón, avisos y error en inglés; reintentar no gasta usos', async () => {
    const link = await createViaUi(ctx, { text: 'secreto-con-pass', pass: 'una-passphrase-larga' });
    const page = await abrir(conLang(link, 'en'));
    await page.click('#reveal');
    await page.waitForFunction(() => document.querySelector('#reveal').textContent === 'Decrypt with passphrase');
    assert.match(await texto(page, '#msg'), /^Enter the passphrase and press Decrypt/);
    assert.equal(await texto(page, 'label[for=pass]'), 'Passphrase');
    await page.type('#pass', 'incorrecta-incorrecta');
    await page.click('#reveal');
    await page.waitForFunction(() => /^Wrong passphrase/.test(document.querySelector('#msg').textContent));
    assert.equal(await texto(page, '#reveal'), 'Decrypt with passphrase');
    await elegir(page, 'es');
    assert.match(await texto(page, '#msg'), /^Passphrase incorrecta/);
    assert.equal(await texto(page, '#reveal'), 'Descifrar con passphrase', 'el botón conserva su estado y cambia de idioma');
    await page.close();
  });

  it('estado: titular, pasos, detalles y fechas en inglés; se traduce sin recargar', async () => {
    const c = await ctx.api.create({ maxUses: 1, caseRef: 'CASE-9', notify: { email: 'a@b.co', rotate: true } });
    await ctx.api.reveal(c.id);
    const page = await abrir(`/status.html?lang=en#${c.id}:${c.statusToken}`);
    const vista = () => page.evaluate(() => ({
      titular: document.querySelector('#headline').textContent,
      pasos: [...document.querySelectorAll('.step')].map((s) => [s.querySelector('.label').textContent, s.querySelector('.sub').textContent]),
      filas: [...document.querySelectorAll('#stat dt')].map((x) => x.textContent),
      vivo: document.querySelector('#liveText').textContent,
      lista: document.querySelector('#stepper').getAttribute('aria-label'),
    }));
    let v = await vista();
    assert.equal(v.titular, 'Fully read. Rotation pending confirmation.');
    assert.deepEqual(v.pasos.map((p) => p[0]), ['Created', 'Read', 'Rotated']);
    assert.deepEqual(v.pasos.slice(1), [['Read', '1 of 1'], ['Rotated', 'Reminders 0 of 3']]);
    assert.deepEqual(v.filas, ['Reference', 'Reads', 'Read 1', 'Created', 'Expires', 'Reminders']);
    assert.equal(v.vivo, 'Updates automatically every 5 seconds.');
    assert.equal(v.lista, 'Secret progress');
    assert.equal(await texto(page, 'h1'), 'Your secret’s status');
    assert.equal(await texto(page, 'main p:last-of-type a'), 'Create another secret');

    await elegir(page, 'es');
    v = await vista();
    assert.equal(v.titular, 'Leído por completo. Rotación pendiente de confirmación.');
    assert.deepEqual(v.pasos.map((p) => p[0]), ['Creado', 'Leído', 'Rotado']);
    assert.deepEqual(v.pasos.slice(1), [['Leído', '1 de 1'], ['Rotado', 'Recordatorios 0 de 3']]);
    assert.deepEqual(v.filas, ['Referencia', 'Lecturas', 'Lectura 1', 'Creado', 'Expira', 'Recordatorios']);
    assert.equal(v.vivo, 'Se actualiza solo cada 5 segundos.');
    await page.close();
  });

  it('estado: las fechas siguen el idioma elegido', async () => {
    const c = await ctx.api.create({ maxUses: 1 });
    const page = await abrir(`/status.html?lang=en#${c.id}:${c.statusToken}`);
    const fecha = () => page.$eval('#stat dd:nth-of-type(2)', (e) => e.textContent);   // "Created"
    const ahora = await page.evaluate(() => ({ en: new Date().toLocaleString('en'), es: new Date().toLocaleString('es') }));
    assert.match(await fecha(), /\b(AM|PM)\b/, `esperaba formato inglés (${ahora.en})`);
    await elegir(page, 'es');
    assert.doesNotMatch(await fecha(), /\b(AM|PM)\b/, `esperaba formato español (${ahora.es})`);
    await page.close();
  });

  it('estado: mensajes de error en los dos idiomas', async () => {
    const mal = await abrir('/status.html?lang=en#AAAAAAAAAAAAAAAAAAAAAA:token');
    assert.equal(await texto(mal, '#headline'), 'This secret was not found or the link is invalid.');
    await elegir(mal, 'es');
    assert.equal(await texto(mal, '#headline'), 'No se encontró este secreto o el link es inválido.');
    await mal.close();
    const roto = await abrir('/status.html?lang=en');
    assert.equal(await texto(roto, '#headline'), 'This link is incomplete.');
    await roto.close();
  });

  it('ack: la página abre en el idioma del correo y confirma en ese idioma', async () => {
    const c = await ctx.api.create({ maxUses: 1, notify: { email: 'a@b.co', rotate: true } });
    await ctx.api.reveal(c.id);
    const page = await abrir(`/ack.html?lang=en#${c.id}:token`);
    assert.equal(await texto(page, 'h1'), 'Confirm rotation');
    assert.equal(await texto(page, '#ack'), 'I confirm I rotated the credential');
    assert.equal(await texto(page, '#ackHint'), 'Once you confirm, Cirrus stops sending you reminders.');
    await page.click('#ack');
    await page.waitForFunction(() => !document.querySelector('#msg').hidden);
    assert.equal(await texto(page, '#msg'), 'Done, rotation confirmed. We will not send any more reminders.');
    await elegir(page, 'es');
    assert.equal(await texto(page, '#msg'), 'Listo, rotación confirmada. No enviaremos más recordatorios.');
    await page.close();
  });

  it('ack: link inválido y link incompleto', async () => {
    const c = await ctx.api.create({ maxUses: 1 });
    const mal = await abrir('/ack.html?lang=en#AAAAAAAAAAAAAAAAAAAAAA:token');
    await mal.click('#ack');
    await mal.waitForFunction(() => !document.querySelector('#msg').hidden);
    assert.equal(await texto(mal, '#msg'), 'Could not confirm (invalid or expired link).');
    await mal.close();
    const roto = await abrir('/ack.html?lang=en');
    assert.equal(await texto(roto, '#msg'), 'This link is incomplete.');
    await roto.close();
    assert.ok(c.id);
  });
});

describe('idioma: accesibilidad y salud', { skip }, () => {
  async function auditar(page) {
    await page.addScriptTag({ path: axePath });
    const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } }));
    return r.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }

  it('las cuatro páginas en inglés no tienen violaciones WCAG 2.1 A/AA', async () => {
    const c = await ctx.api.create({ maxUses: 3, pass: true, caseRef: 'CASE-1', notify: { email: 'a@b.co', rotate: true } });
    await ctx.api.reveal(c.id);
    for (const url of ['/index.html', `/reveal.html?lang=en#${c.id}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, `/status.html#${c.id}:${c.statusToken}`, `/ack.html#${c.id}:token`]) {
      const page = await abrir(url, { bypassCSP: true, languages: ['en-US'] });
      assert.equal(await idioma(page), 'en', url);
      assert.deepEqual(await auditar(page), [], url);
      await page.close();
    }
  });

  it('el interruptor de idioma cumple contraste y tamaño táctil, también en móvil', async () => {
    const page = await abrir('/index.html', { width: 360, height: 800, bypassCSP: true });
    const caja = await page.$$eval('.lang-opt', (b) => b.map((x) => { const r = x.getBoundingClientRect(); return [r.width, r.height]; }));
    for (const [w, h] of caja) assert.ok(w >= 24 && h >= 24, `objetivo táctil ${w}x${h} (WCAG 2.5.8 pide >= 24 px)`);
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    assert.equal(sw, iw, 'desborde horizontal');
    assert.deepEqual(await auditar(page), []);
    await page.close();
  });

  it('sin errores de consola ni de CSP', () => {
    assert.deepEqual(sinErroresReales(ctx.problems), []);
  });
});
