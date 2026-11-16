// Correos: cada aviso se envía en HTML y en texto plano a partir del mismo modelo.
// Se prueba el renderizador (src/lifecycle/email.mjs) y los correos reales de lifecycle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register.mjs';

process.env.TABLE = 'tabla-de-prueba';
process.env.STATE_MACHINE = 'arn:sm-de-prueba';
process.env.SENDER = 'cirrus@demo.test';
process.env.SITE_URL = 'https://site.test';
process.env.REMINDER_WAIT = '30';

const { render, esc } = await import('../../src/lifecycle/email.mjs');
const { store } = await import('../helpers/fake-sdk/lib-dynamodb.mjs');
const { sent } = await import('../helpers/fake-sdk/client-sesv2.mjs');
const create = (await import('../../src/create/index.mjs')).handler;
const lifecycle = (await import('../../src/lifecycle/index.mjs')).handler;

const AKIA = 'AKIAIOSFODNN7EXAMPLE';

describe('email: escape', () => {
  it('esc escapa los cinco caracteres peligrosos y tolera valores nulos', () => {
    assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
  });
});

describe('email: renderizador', () => {
  const modelo = {
    heading: 'Tu secreto se leyó',
    blocks: [
      { type: 'ref', value: 'CASE-1' },
      { type: 'p', text: 'Primer párrafo.' },
      { type: 'alert', text: 'Cuidado.' },
      { type: 'reads', items: ['2026-11-15 10:00:00 UTC', '2026-11-15 10:05:00 UTC'] },
      { type: 'steps', title: 'Checklist de rotación', items: [{ text: 'Desactiva:', code: 'aws iam update-access-key' }, { text: 'Revisa CloudTrail.' }] },
      { type: 'action', intro: 'Confirma aquí:', label: 'Confirmar', url: 'https://site.test/ack.html#ID:TOK' },
    ],
  };
  const { text, html } = render(modelo);

  it('el texto plano conserva el formato de siempre', () => {
    assert.equal(text, [
      'Referencia: CASE-1',
      'Primer párrafo.',
      'Cuidado.',
      'Lecturas:\n  1) 2026-11-15 10:00:00 UTC\n  2) 2026-11-15 10:05:00 UTC',
      'Checklist de rotación:\n1. Desactiva:\n   aws iam update-access-key\n2. Revisa CloudTrail.',
      'Confirma aquí:\n  https://site.test/ack.html#ID:TOK',
    ].join('\n\n'));
  });

  it('el HTML es un documento completo, en español, con título y vista previa', () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<title>Tu secreto se leyó<\/title>/);
    assert.match(html, /<h1[^>]*>Tu secreto se leyó<\/h1>/);
    assert.match(html, />Primer párrafo\.<\/div>/);          // vista previa = primer párrafo, oculta
    assert.match(html, />Cirrus<\/td>/);                      // marca en texto (el SVG no funciona en Gmail/Outlook)
  });

  it('usa solo estilos en línea y ningún recurso externo', () => {
    assert.doesNotMatch(html, /<style|<script|<link|<img|<iframe|url\(|@import|src=/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);            // sin manejadores de eventos
    const enlaces = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(enlaces, ['https://site.test/ack.html#ID:TOK']);
  });

  it('el botón enlaza a la acción y el link queda visible por si el cliente lo recorta', () => {
    assert.match(html, /<a href="https:\/\/site\.test\/ack\.html#ID:TOK"[^>]*>Confirmar<\/a>/);
    assert.match(html, /copia este link: https:\/\/site\.test\/ack\.html#ID:TOK/);
  });

  it('los comandos van en un bloque <pre> aparte de su explicación', () => {
    assert.match(html, /<li[^>]*>Desactiva:<pre[^>]*>aws iam update-access-key<\/pre><\/li>/);
    assert.match(html, /<li[^>]*>Revisa CloudTrail\.<\/li>/);
    assert.match(html, /<ol /);
  });

  it('pesa poco (los clientes recortan el HTML a ~100 KB)', () => {
    assert.ok(html.length < 8000, `${html.length} bytes`);
  });

  it('todo dato del emisor se escapa: nada se inserta como HTML', () => {
    const hostil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const r = render({
      heading: hostil,
      blocks: [
        { type: 'ref', value: hostil },
        { type: 'p', text: hostil },
        { type: 'alert', text: hostil },
        { type: 'reads', items: [hostil] },
        { type: 'steps', title: hostil, items: [{ text: hostil, code: hostil }] },
        { type: 'action', intro: hostil, label: hostil, url: `https://x.test/"onmouseover="alert(3)` },
      ],
    });
    // Ninguna etiqueta real inyectada ni atributo on* dentro de una etiqueta. (El texto escapado sí
    // contiene la palabra "onerror=": es texto visible e inofensivo, no una etiqueta.)
    assert.doesNotMatch(r.html, /<script|<img|<[^>]*\son[a-z]+\s*=/i);
    assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(r.html.includes('href="https://x.test/&quot;onmouseover=&quot;alert(3)"'));
    assert.ok(r.text.includes(hostil), 'el texto plano lleva el valor tal cual (no es HTML)');
  });
});

// ---------------------------------------------------------------- correos reales de lifecycle
async function make(extra, notify) {
  const r = await create({ body: JSON.stringify({ ct: 'AAAA', iv: 'BBBB', ttlSeconds: 3600, maxUses: 3, ...extra, notify }), requestContext: {} });
  const b = JSON.parse(r.body);
  return { ...b, meta: store.get(`META#${b.id}`) };
}
async function mailFor(action, id, patch = {}) {
  Object.assign(store.get(`META#${id}`), patch);
  sent.length = 0;
  await lifecycle({ action, id });
  return sent[0];
}
const lecturas = { reads: 3, readLog: [1700000000, 1700000100, 1700000200] };

describe('email: correos de lifecycle', () => {
  it('todos los avisos salen en HTML y en texto plano, del mismo remitente al emisor', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true });
    const casos = [
      ['notifyFirstRead', { reads: 1, readLog: [1700000000] }],
      ['notifyRead', lecturas],
      ['notifyExpired', lecturas],
      ['notifyExpired', { reads: 0, readLog: [] }],
      ['sendReminder', {}],
      ['giveUp', {}],
    ];
    for (const [accion, patch] of casos) {
      const m = await mailFor(accion, c.id, patch);
      assert.ok(m, `${accion}: no se envió`);
      assert.match(m.html, /^<!doctype html>/, `${accion}: sin HTML`);
      assert.ok(m.text.length > 20, `${accion}: sin texto`);
      assert.equal(m.to, 'a@b.co');
      assert.equal(m.from, 'cirrus@demo.test');
      assert.doesNotMatch(m.subject, /<|>/, 'el asunto es texto plano');
    }
  });

  it('con rotación: el HTML trae el botón de confirmación con el token correcto, la lista y el comando', async () => {
    const c = await make({}, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true });
    const m = await mailFor('notifyRead', c.id, lecturas);
    assert.ok(m.html.includes(`<a href="https://site.test/ack.html#${c.id}:${c.meta.ackToken}"`));
    assert.match(m.html, /<ol /);
    assert.match(m.html, /<pre[^>]*>aws iam update-access-key --user-name USUARIO --access-key-id AKIAIOSFODNN7EXAMPLE --status Inactive<\/pre>/);
    assert.match(m.html, /SIGUE ACTIVA/);
    assert.match(m.html, /<li[^>]*>2023-11-14 22:13:20 UTC<\/li>/);   // historial de lecturas (1700000000)
  });

  it('sin rotación: el HTML no trae lista, botón ni enlaces', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: false });
    const m = await mailFor('notifyRead', c.id, lecturas);
    assert.doesNotMatch(m.html, /<ol|<a |ack\.html|Checklist|SIGUE ACTIVA|<pre/);
    assert.match(m.html, /agotó sus usos/);
  });

  it('la referencia del emisor se escapa en el HTML y el asunto la conserva tal cual', async () => {
    const c = await make({ caseRef: `A&B "q" 'z'` }, { email: 'a@b.co', rotate: false });
    const m = await mailFor('notifyRead', c.id, lecturas);
    assert.ok(m.html.includes('Referencia: A&amp;B &quot;q&quot; &#39;z&#39;'));
    assert.ok(!m.html.includes(`A&B "q"`));
    assert.ok(m.subject.includes(`[A&B "q" 'z']`));
    assert.ok(m.text.includes(`Referencia: A&B "q" 'z'`));
  });

  it('el HTML y el texto cuentan lo mismo: cada paso del checklist aparece en ambos', async () => {
    for (const clase of ['aws-access-key', 'gcp-sa', 'azure-secret', 'github-token', 'slack-token', 'pem', 'conn-string', 'env', 'aws-temp', 'generic']) {
      const extra = clase === 'gcp-sa' ? { keyId: 'b'.repeat(40), account: 'robot@demo.iam.gserviceaccount.com' } : clase === 'aws-access-key' ? { keyId: AKIA } : {};
      const c = await make({}, { email: 'a@b.co', credClass: clase, rotate: true, ...extra });
      const m = await mailFor('sendReminder', c.id);
      const pasos = m.text.split('Checklist de rotación:\n')[1].split('\n\n')[0].split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
      assert.ok(pasos.length >= 1, clase);
      for (const p of pasos) assert.ok(m.html.includes(p.replaceAll('&', '&amp;').replaceAll('>', '&gt;')), `${clase}: falta en el HTML «${p}»`);
    }
  });

  it('un recordatorio indica en el título cuántos van', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: true });
    const m = await mailFor('sendReminder', c.id);
    assert.match(m.html, /<h1[^>]*>Recordatorio 1 de 3: rota la credencial<\/h1>/);
  });
});
