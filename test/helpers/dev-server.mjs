// Servidor de desarrollo local: sirve web/ con las MISMAS cabeceras de seguridad que CloudFront
// (la CSP se lee de template.yaml) y simula la API en memoria. No toca AWS.
//
//   npm run dev:web            ->  http://localhost:8080
//
// También lo usan las pruebas de interfaz (test/ui), que lo arrancan en un puerto libre.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../web/', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../template.yaml', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };

// La CSP real vive en template.yaml (SecurityHeaders): se lee de ahí para que no se desincronice
async function readCsp() {
  const yaml = await readFile(TEMPLATE, 'utf8');
  const m = yaml.match(/ContentSecurityPolicy: "([^"]+)"/);
  if (!m) throw new Error('No se encontró la CSP en template.yaml');
  return m[1];
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); });
const now = () => Math.floor(Date.now() / 1000);

export async function startDevServer({ port = 8080 } = {}) {
  const csp = await readCsp();
  const secrets = new Map();   // id -> { ct, iv, maxUses, usesLeft, expiresAt, pass, caseRef }
  const metas = new Map();     // id -> estado visible en la página de estado
  let lastCreate = null;       // última petición de creación (solo para las pruebas)

  async function api(req, res, url) {
    if (url.pathname === '/api/__last') return json(res, 200, lastCreate ?? {});

    if (req.method === 'POST' && url.pathname === '/api/secrets') {
      const d = JSON.parse((await readBody(req)) || '{}');
      lastCreate = d;
      const id = randomBytes(16).toString('base64url');
      const statusToken = randomBytes(16).toString('base64url');
      const maxUses = d.maxUses ?? 1;
      const expiresAt = now() + d.ttlSeconds;
      secrets.set(id, { ct: d.ct, iv: d.iv, maxUses, usesLeft: maxUses, expiresAt, pass: d.pass === true, caseRef: d.caseRef ?? null });
      metas.set(id, {
        status: 'CREATED', createdAt: now(), expiresAt, reads: 0, maxUses, attempts: 0, readLog: [], statusToken, caseRef: d.caseRef ?? null,
        notify: Boolean(d.notify), rotate: Boolean(d.notify) && d.notify.rotate !== false,
      });
      return json(res, 201, { id, maxUses, statusToken });
    }

    if (req.method === 'POST' && url.pathname === '/api/ack') {
      const d = JSON.parse((await readBody(req)) || '{}');
      const meta = metas.get(d.id);
      if (meta) meta.status = 'ACKED';
      return json(res, meta ? 200 : 404, meta ? { status: 'ACKED' } : { error: 'not_found' });
    }

    const m = url.pathname.match(/^\/api\/secrets\/([^/]+)\/(info|reveal|status)$/);
    if (!m) return json(res, 404, { error: 'not_found' });
    const [, id, kind] = m;
    const s = secrets.get(id), meta = metas.get(id);

    if (kind === 'status') {
      if (!meta || req.headers['x-status-token'] !== meta.statusToken) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { ...meta, statusToken: undefined });
    }
    if (!s || s.expiresAt <= now() || s.usesLeft <= 0) return json(res, 404, { error: 'not_found_or_used' });
    if (kind === 'info') return json(res, 200, { usesLeft: s.usesLeft, maxUses: s.maxUses, expiresAt: s.expiresAt, pass: s.pass, caseRef: s.caseRef });

    s.usesLeft -= 1;
    meta.reads += 1; meta.readLog.push(now());
    if (s.usesLeft === 0) { meta.status = 'READ'; secrets.delete(id); }
    return json(res, 200, { ct: s.ct, iv: s.iv, usesLeft: s.usesLeft, maxUses: s.maxUses, pass: s.pass, caseRef: s.caseRef });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const body = await readFile(join(ROOT, rel));
      res.writeHead(200, {
        'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });

  await new Promise((ok) => server.listen(port, ok));
  const { port: actual } = server.address();
  return { port: actual, base: `http://localhost:${actual}`, close: () => new Promise((ok) => server.close(ok)) };
}

// Ejecución directa: npm run dev:web
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { base } = await startDevServer({ port: Number(process.env.PORT ?? 8080) });
  console.log(`Cirrus (desarrollo local, API simulada): ${base}`);
}
