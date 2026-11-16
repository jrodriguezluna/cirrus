// Ayudantes para las pruebas de interfaz: Chrome (puppeteer-core) + el servidor de desarrollo local.
// Si no hay Chrome instalado, launch() devuelve null y las pruebas se omiten (define CHROME_PATH).
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { startDevServer } from './dev-server.mjs';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean).find((p) => existsSync(p));
}

export async function launch() {
  const chrome = findChrome();
  if (!chrome) return null;
  const server = await startDevServer({ port: 0 });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const problems = [];   // errores y avisos de consola, errores de página y recursos que fallaron (incluye violaciones de CSP)

  async function open(url, { width = 1100, height = 900, bypassCSP = false, reducedMotion = false, colorScheme = 'light' } = {}) {
    const page = await browser.newPage();
    if (bypassCSP) await page.setBypassCSP(true);     // solo para inyectar axe-core
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: colorScheme },
      { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' },
    ]);
    await page.setViewport({ width, height });
    // networkidle2 (no 0): una respuesta 404 cuyo cuerpo la página no lee queda "en curso" para Puppeteer
    await page.goto(url.startsWith('http') ? url : server.base + url, { waitUntil: 'networkidle2' });
    return page;
  }

  const post = (path, body) => fetch(server.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json().catch(() => ({})));
  return {
    base: server.base,
    open,
    problems,
    // API simulada, para preparar situaciones sin pasar por la interfaz
    api: {
      create: (body = {}) => post('/api/secrets', { ct: 'AAAA', iv: 'BBBB', ttlSeconds: 3600, maxUses: 1, ...body }),
      reveal: (id) => fetch(`${server.base}/api/secrets/${id}/reveal`, { method: 'POST' }),
      lastCreate: () => fetch(`${server.base}/api/__last`).then((r) => r.json()),
    },
    close: async () => { await browser.close(); await server.close(); },
  };
}

// Vacía el textarea del secreto como lo haría un usuario (evento input) y escribe de nuevo
export async function typeSecret(page, text) {
  await page.evaluate(() => { const t = document.querySelector('#secret'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); });
  if (text) await page.type('#secret', text);
}

// Crea un secreto con la interfaz real (cifrado de verdad) y devuelve el link
export async function createViaUi(ctx, { text, uses = 1, pass } = {}) {
  const page = await ctx.open('/index.html');
  await page.type('#secret', text);
  if (uses > 1) await page.click(`#uses + .seg .seg-opt:nth-child(${uses})`);
  if (pass) { await page.click('.adv summary'); await page.type('#pass', pass); }
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  const link = await page.$eval('#link', (e) => e.value);
  await page.close();
  return link;
}

// Los 404 de la API son parte de varios escenarios (secreto ya usado, expirado, inexistente)
export const sinErroresReales = (problems) => problems.filter((p) => !/status of 404/.test(p));
