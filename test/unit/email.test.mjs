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
    assert.ok(m.html.includes(`<a href="https://site.test/ack.html?lang=es#${c.id}:${c.meta.ackToken}"`));
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

// ---------------------------------------------------------------- idioma de los correos
// El emisor elige es / en en la web (notify.lang); todos los avisos salen en ese idioma.
const ACCIONES = [
  ['notifyFirstRead', { reads: 1, readLog: [1700000000] }],
  ['notifyRead', lecturas],
  ['notifyExpired', lecturas],
  ['notifyExpired', { reads: 0, readLog: [] }],
  ['sendReminder', {}],
  ['giveUp', {}],
];
// Palabras que solo aparecen en los textos en español
const ESPANOL = /\b(tu secreto|Tu secreto|secreto|Recordatorio|Checklist|credencial|Referencia|Lecturas|Enviado por|Desactiva|Revisa|Último|expiró|abrió|leyó)\b/;

describe('email: idioma elegido por el emisor', () => {
  it('create guarda el idioma en META; sin idioma, español; sin seguimiento no se guarda nada', async () => {
    assert.equal((await make({}, { email: 'a@b.co', lang: 'en' })).meta.lang, 'en');
    assert.equal((await make({}, { email: 'a@b.co', lang: 'es' })).meta.lang, 'es');
    assert.equal((await make({}, { email: 'a@b.co' })).meta.lang, 'es');
    assert.equal((await make({}, undefined)).meta.lang, undefined);
  });

  it('todos los avisos en inglés: asunto, HTML (lang="en") y texto, sin rastro del español', async () => {
    const c = await make({ caseRef: 'CASE-1' }, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true, lang: 'en' });
    for (const [accion, patch] of ACCIONES) {
      const m = await mailFor(accion, c.id, patch);
      assert.ok(m, accion);
      assert.match(m.html, /<html lang="en">/, accion);
      assert.doesNotMatch(m.subject, ESPANOL, `${accion}: asunto «${m.subject}»`);
      assert.doesNotMatch(m.text, ESPANOL, `${accion}: texto`);
      assert.doesNotMatch(m.html.replace(/<[^>]+>/g, ' '), ESPANOL, `${accion}: HTML`);
      assert.match(m.text, /Reference: CASE-1/, accion);
      assert.match(m.html, /Sent by Cirrus/, accion);
    }
  });

  it('mismo aviso, mismo contenido: en inglés cambia el idioma, no la estructura', async () => {
    const lectura = async (lang) => {
      const c = await make({ caseRef: 'CASE-1' }, { email: 'a@b.co', credClass: 'aws-access-key', keyId: AKIA, rotate: true, lang });
      return mailFor('notifyRead', c.id, lecturas);
    };
    const es = await lectura('es'), en = await lectura('en');
    const forma = (m) => m.html.replace(/<html lang="\w+">/, '<html>').replace(/>[^<]+</g, '><').replace(/ack\.html\?lang=\w+#[\w-]+:[\w-]+/, 'ACK').replace(/\s+/g, ' ');
    assert.equal(forma(en), forma(es));
    assert.equal(en.subject, 'Cirrus [CASE-1]: your secret was fully read (3 of 3)');
    assert.equal(es.subject, 'Cirrus [CASE-1]: tu secreto se leyó por completo (3 de 3)');
    assert.match(en.text, /Your secret \w+… has used up all its uses\. The link no longer works\./);
    assert.match(en.text, /But the credential is STILL ACTIVE in its source account\./);
    assert.match(en.text, /Rotation checklist:\n1\. Deactivate the key \(reversible\):\n {3}aws iam update-access-key --user-name USERNAME/);
    assert.match(en.text, /Reads:\n {2}1\) 2023-11-14 22:13:20 UTC/);
  });

  it('el link de confirmación lleva el idioma del correo, para que la página se abra igual', async () => {
    for (const lang of ['es', 'en']) {
      const c = await make({}, { email: 'a@b.co', rotate: true, lang });
      for (const accion of ['notifyRead', 'sendReminder']) {
        const m = await mailFor(accion, c.id, lecturas);
        assert.ok(m.html.includes(`href="https://site.test/ack.html?lang=${lang}#${c.id}:${c.meta.ackToken}"`), `${lang} ${accion}`);
        assert.ok(m.text.includes(`https://site.test/ack.html?lang=${lang}#${c.id}:${c.meta.ackToken}`), `${lang} ${accion} (texto)`);
      }
    }
  });

  it('el checklist en inglés tiene los mismos pasos y los mismos comandos que el español', async () => {
    const normalizar = (s) => s.replaceAll('USERNAME', 'USUARIO').replaceAll('YOUR_KEY_ID', 'TU_KEY_ID');
    for (const clase of ['aws-access-key', 'gcp-sa', 'azure-secret', 'github-token', 'slack-token', 'pem', 'conn-string', 'env', 'aws-temp', 'generic']) {
      const extra = clase === 'gcp-sa' ? { keyId: 'b'.repeat(40), account: 'robot@demo.iam.gserviceaccount.com' } : {};
      const pasos = {};
      for (const lang of ['es', 'en']) {
        const c = await make({}, { email: 'a@b.co', credClass: clase, rotate: true, lang, ...extra });
        const m = await mailFor('sendReminder', c.id);
        pasos[lang] = m.text.split(/(?:Checklist de rotación|Rotation checklist):\n/)[1].split('\n\n')[0].split('\n');
      }
      assert.equal(pasos.en.length, pasos.es.length, `${clase}: distinto número de líneas`);
      const comandos = (l) => l.filter((x) => /^ {3}\S/.test(x)).map(normalizar);
      assert.deepEqual(comandos(pasos.en), comandos(pasos.es), `${clase}: los comandos no deben traducirse`);
      const prosa = (l) => l.filter((x) => /^\d+\. /.test(x));
      assert.notDeepEqual(prosa(pasos.en), prosa(pasos.es), `${clase}: sin traducir`);
    }
  });

  it('en inglés, HTML y texto cuentan lo mismo: cada paso del checklist aparece en ambos', async () => {
    for (const clase of ['aws-access-key', 'azure-secret', 'github-token', 'conn-string']) {
      const c = await make({}, { email: 'a@b.co', credClass: clase, rotate: true, lang: 'en', ...(clase === 'aws-access-key' ? { keyId: AKIA } : {}) });
      const m = await mailFor('sendReminder', c.id);
      const pasos = m.text.split('Rotation checklist:\n')[1].split('\n\n')[0].split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
      assert.ok(pasos.length >= 1, clase);
      for (const p of pasos) assert.ok(m.html.includes(esc(p)), `${clase}: falta en el HTML «${p}»`);
    }
  });

  it('un recordatorio en inglés indica en el título cuántos van', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: true, lang: 'en' });
    const m = await mailFor('sendReminder', c.id);
    assert.match(m.html, /<h1[^>]*>Reminder 1 of 3: rotate the credential<\/h1>/);
    assert.equal(m.subject, 'Cirrus: reminder 1 of 3, rotate the credential');
  });

  it('plural del primer acceso en inglés', async () => {
    const c = await make({}, { email: 'a@b.co', lang: 'en' });          // 3 usos
    const m = await mailFor('notifyFirstRead', c.id, { reads: 1, readLog: [1700000000] });
    assert.match(m.text, /2 uses left of 3\./);
    const m2 = await mailFor('notifyFirstRead', c.id, { reads: 2, readLog: [1700000000, 1700000100] });
    assert.match(m2.text, /1 use left of 3\./);
  });

  it('un idioma desconocido o ausente en META (registros anteriores) cae en español', async () => {
    const c = await make({}, { email: 'a@b.co', rotate: true, lang: 'en' });
    for (const lang of [undefined, 'fr', '__proto__']) {
      const meta = store.get(`META#${c.id}`);
      if (lang === undefined) delete meta.lang; else meta.lang = lang;
      const m = await mailFor('notifyRead', c.id, lecturas);
      assert.match(m.html, /<html lang="es">/, String(lang));
      assert.match(m.subject, /tu secreto se leyó por completo/);
      assert.ok(m.html.includes('ack.html?lang=es#'), String(lang));
    }
  });

  it('el renderizador acepta lang y por defecto usa español', () => {
    const modelo = { heading: 'H', blocks: [{ type: 'ref', value: 'X' }, { type: 'reads', items: ['a'] }, { type: 'action', intro: 'i', label: 'l', url: 'https://x.test/' }] };
    const en = render({ ...modelo, lang: 'en' });
    assert.match(en.html, /<html lang="en">/);
    assert.match(en.text, /^Reference: X\n\nReads:\n {2}1\) a/);
    assert.match(en.html, />Reads<\/p>/);
    assert.match(en.html, /If the button does not work, copy this link: https:\/\/x\.test\//);
    const es = render(modelo);
    assert.match(es.html, /<html lang="es">/);
    assert.match(es.text, /^Referencia: X\n\nLecturas:/);
    assert.deepEqual(render({ ...modelo, lang: 'fr' }), es);
    assert.deepEqual(render({ ...modelo, lang: 'constructor' }), es);
  });
});
