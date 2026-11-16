// Accesibilidad y robustez visual: axe-core (WCAG 2 A/AA), teclado, desbordes en móvil,
// movimiento reducido, tema claro obligatorio y carga de la fuente bajo la CSP real.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launch, wait, sinErroresReales } from '../helpers/browser.mjs';

const ctx = await launch();
after(() => ctx?.close());
const skip = ctx ? false : 'Chrome no encontrado: instala Chrome/Chromium o define CHROME_PATH';
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

// Una página de cada tipo, con datos reales de la API simulada
const c = ctx ? await ctx.api.create({ maxUses: 3, pass: true, caseRef: 'CASE-1', notify: { email: 'a@b.co', rotate: true } }) : null;
if (ctx) await ctx.api.reveal(c.id);
const PAGES = ctx ? {
  'index.html': '/index.html',
  'reveal.html': `/reveal.html#${c.id}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  'status.html': `/status.html#${c.id}:${c.statusToken}`,
  'ack.html': `/ack.html#${c.id}:token`,
} : {};

async function auditar(page) {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } }));
  return r.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

describe('accesibilidad: axe-core', { skip }, () => {
  for (const [nombre, url] of Object.entries(PAGES)) {
    it(`${nombre}: sin violaciones WCAG 2.1 A/AA`, async () => {
      const page = await ctx.open(url, { bypassCSP: true });
      assert.deepEqual(await auditar(page), []);
      await page.close();
    });
  }

  it('index.html con todos los bloques visibles (detección, avanzado, seguimiento, resultado): sin violaciones', async () => {
    const page = await ctx.open('/index.html', { bypassCSP: true });
    await page.type('#secret', 'AKIAIOSFODNN7EXAMPLE');
    await page.click('.adv summary'); await page.click('#notify'); await page.type('#email', 'a@b.co');
    await page.click('#go'); await page.waitForSelector('#result:not([hidden])'); await wait(2500);
    assert.deepEqual(await auditar(page), []);
    await page.close();
  });
});

describe('responsive', { skip }, () => {
  for (const [nombre, url] of Object.entries(PAGES)) {
    it(`${nombre}: sin desborde horizontal a 320 px`, async () => {
      const page = await ctx.open(url, { width: 320, height: 700 });
      const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      assert.equal(sw, iw);
      await page.close();
    });
  }

  it('el control de caducidad cabe y es táctil (alto >= 40 px) en móvil', async () => {
    const page = await ctx.open('/index.html', { width: 360, height: 800 });
    const { alto, ancho, caja } = await page.evaluate(() => {
      const o = document.querySelector('#ttl + .seg .seg-opt'); const seg = document.querySelector('#ttl + .seg');
      return { alto: o.getBoundingClientRect().height, ancho: seg.scrollWidth, caja: seg.clientWidth };
    });
    assert.ok(alto >= 40, `alto ${alto}`);
    assert.ok(ancho <= caja, 'las opciones desbordan el control');
    await page.close();
  });
});

describe('teclado', { skip }, () => {
  it('el orden de Tab en index es lógico y todo muestra un foco visible', async () => {
    const page = await ctx.open('/index.html');
    const vistos = [];
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Tab');
      vistos.push(await page.evaluate(() => {
        const e = document.activeElement; const cs = getComputedStyle(e);
        return { id: e.id || e.className.split(' ')[0] || e.tagName.toLowerCase(), foco: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' };
      }));
    }
    // idioma ES y EN, logo, secreto, caducidad (1 parada), usos (1 parada), "Más opciones", seguimiento, botón
    assert.deepEqual(vistos.map((v) => v.id), ['lang-opt', 'lang-opt', 'brand', 'secret', 'seg-opt', 'seg-opt', 'summary', 'notify', 'go']);
    assert.ok(vistos.every((v) => v.foco), `sin foco visible: ${JSON.stringify(vistos.filter((v) => !v.foco))}`);
    await page.close();
  });

  it('los controles segmentados son un grupo de radio: una sola parada de Tab y flechas para moverse', async () => {
    const page = await ctx.open('/index.html');
    assert.equal(await page.$eval('#ttl + .seg', (e) => e.getAttribute('role')), 'radiogroup');
    const tabulables = await page.$$eval('#ttl + .seg .seg-opt', (bs) => bs.filter((b) => b.tabIndex === 0).length);
    assert.equal(tabulables, 1);
    assert.equal(await page.$eval('#ttl + .seg .on', (b) => b.getAttribute('aria-checked')), 'true');
    await page.close();
  });
});

describe('movimiento y tema', { skip }, () => {
  it('con movimiento reducido, las animaciones infinitas se reducen a ~0', async () => {
    const page = await ctx.open(PAGES['status.html'], { reducedMotion: true });
    const dur = await page.$eval('.pulse', (e) => parseFloat(getComputedStyle(e).animationDuration));
    assert.ok(dur < 0.001, `duración ${dur}s`);
    await page.close();
  });

  it('es siempre claro: con el sistema en modo oscuro la página no cambia y no hay selector de tema', async () => {
    const page = await ctx.open('/index.html', { colorScheme: 'dark' });
    assert.deepEqual(await page.evaluate(() => ({
      esquema: getComputedStyle(document.documentElement).colorScheme,
      tarjeta: getComputedStyle(document.querySelector('main')).backgroundColor,
      campo: getComputedStyle(document.querySelector('#secret')).backgroundColor,
      selector: Boolean(document.querySelector('.theme-toggle, [data-theme]')),
    })), { esquema: 'light', tarjeta: 'rgb(255, 255, 255)', campo: 'rgb(255, 255, 255)', selector: false });
    await page.close();
  });

  it('la fuente Nunito se carga bajo la CSP real', async () => {
    const page = await ctx.open('/index.html');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('1rem Nunito')), true);
    assert.ok(await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Nunito') && f.status === 'loaded')));
    await page.close();
  });

  it('las imágenes decorativas del avión están ocultas a lectores de pantalla', async () => {
    for (const [url, id] of [['/index.html', '#flyPlane'], ['/ack.html', '#takeoffPlane']]) {
      const page = await ctx.open(url);
      assert.equal(await page.$eval(id, (e) => e.getAttribute('aria-hidden')), 'true');
      assert.equal(await page.$eval(id, (e) => e.getAttribute('alt')), '');
      await page.close();
    }
  });
});

describe('accesibilidad: salud', { skip }, () => {
  it('sin errores de consola ni de CSP', () => {
    assert.deepEqual(sinErroresReales(ctx.problems), []);
  });
});
