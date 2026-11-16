// Internacionalización (es / en): los diccionarios de la web son coherentes entre sí, todo texto
// marcado en el HTML y todo texto pedido desde el JS existe, y la detección de credenciales habla los dos idiomas.
// No necesitan navegador; el cambio de idioma en pantalla se prueba en test/ui/i18n.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from '../../web/messages.js';
import { detect, describe as describeCred } from '../../web/detect.js';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const files = readdirSync(WEB);
const read = (f) => readFileSync(join(WEB, f), 'utf8');
const html = files.filter((f) => f.endsWith('.html'));
const scripts = files.filter((f) => f.endsWith('.js') && f !== 'messages.js');   // incluye i18n.js (pide lang.label)
const { es, en } = MESSAGES;
const placeholders = (v) => (typeof v === 'string' ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort() : []);

describe('i18n: diccionarios', () => {
  it('hay exactamente dos idiomas: es y en', () => assert.deepEqual(Object.keys(MESSAGES).sort(), ['en', 'es']));

  it('es y en tienen las mismas claves', () => {
    assert.deepEqual(Object.keys(en).filter((k) => !(k in es)), [], 'claves solo en inglés');
    assert.deepEqual(Object.keys(es).filter((k) => !(k in en)), [], 'claves solo en español');
  });

  it('ningún texto está vacío', () => {
    for (const lang of [es, en]) for (const [k, v] of Object.entries(lang)) assert.ok(typeof v === 'function' || v.trim(), k);
  });

  it('cada clave es del mismo tipo (texto o función) y usa los mismos {parámetros} en los dos idiomas', () => {
    for (const k of Object.keys(es)) {
      assert.equal(typeof en[k], typeof es[k], `${k}: tipo distinto`);
      assert.deepEqual(placeholders(en[k]), placeholders(es[k]), `${k}: parámetros distintos`);
    }
  });

  it('las funciones de plural responden con 0, 1 y varios', () => {
    for (const lang of [es, en]) {
      for (const k of ['reveal.left', 'reveal.dots']) for (const n of [0, 1, 2]) assert.match(lang[k]({ n, max: 3 }), /\S/, `${k}(${n})`);
      for (const n of [1, 3]) assert.match(lang['uses.times']({ n }), /\S/);
    }
    assert.equal(es['reveal.left']({ n: 1, max: 1 }), 'Queda 1 uso de 1');
    assert.equal(es['reveal.left']({ n: 2, max: 3 }), 'Quedan 2 usos de 3');
    assert.equal(en['reveal.left']({ n: 1, max: 1 }), '1 use left of 1');
    assert.equal(en['reveal.left']({ n: 2, max: 3 }), '2 uses left of 3');
  });

  it('el inglés realmente está traducido (ningún texto largo idéntico al español)', () => {
    const iguales = Object.keys(es).filter((k) => typeof es[k] === 'string' && es[k].length > 25 && es[k] === en[k]);
    assert.deepEqual(iguales, []);
  });
});

describe('i18n: uso de las claves', () => {
  const documentadas = new Set(Object.keys(es));

  it('toda clave de data-i18n / data-i18n-attr del HTML existe', () => {
    for (const f of html) {
      const src = read(f);
      const claves = [
        ...[...src.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
        ...[...src.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((p) => p.split(':')[1].trim())),
      ];
      assert.ok(claves.length > 0, `${f} no tiene textos traducibles`);
      for (const k of claves) assert.ok(documentadas.has(k), `${f}: falta la clave ${k}`);
    }
  });

  it('toda clave que pide el JS existe', () => {
    const forma = /['"`]((?:index|detect|rotate|err|chip|note|mail|reveal|status|ack|ttl|uses|brand|lang|link)\.[\w.]+|footer|copied|copyManual)['"`]/g;
    for (const f of scripts) {
      for (const [, k] of read(f).matchAll(forma)) assert.ok(documentadas.has(k), `${f}: falta la clave ${k}`);
    }
  });

  it('no sobran claves: cada una se usa en el HTML o en el JS', () => {
    const fuentes = [...html, ...scripts].map(read).join('\n');
    const dinamicas = ['ttl.name.']; // `ttl.name.${segundos}`
    const sobran = [...documentadas].filter((k) => !fuentes.includes(`"${k}"`) && !fuentes.includes(`'${k}'`) && !fuentes.includes(`:${k}"`) && !fuentes.includes(`;${k}`)
      && !dinamicas.some((p) => k.startsWith(p)));
    assert.deepEqual(sobran, []);
  });

  it('las claves dinámicas ttl.name.* cubren todas las caducidades del formulario', () => {
    const valores = [...read('index.html').matchAll(/<option value="(\d+)" data-short="[^"]+"(?: data-i18n="index\.ttl\.\d+")/g)].map((m) => m[1]);
    assert.deepEqual(valores, ['60', '300', '3600', '86400', '604800']);
    for (const v of valores) assert.ok(documentadas.has(`ttl.name.${v}`) && documentadas.has(`index.ttl.${v}`), v);
  });

  it('el HTML conserva el texto en español como contenido inicial (igual que el diccionario es)', () => {
    for (const f of html) {
      for (const [, key, text] of read(f).matchAll(/data-i18n="([^"]+)"[^>]*>([^<]+)</g)) {
        assert.equal(text.trim(), es[key], `${f}: «${text.trim()}» no coincide con es[${key}]`);
      }
    }
  });

  it('el JS no deja textos de interfaz sueltos: nada de textContent con literal en español', () => {
    const sospechoso = /textContent\s*=\s*['"`][^'"`]*[a-záéíóúñ]{4,}[^'"`]*['"`]/i;
    for (const f of scripts.filter((x) => x !== 'i18n.js')) {
      for (const linea of read(f).split('\n')) {
        if (/^\s*\/\//.test(linea)) continue;
        assert.doesNotMatch(linea, sospechoso, `${f}: ${linea.trim()}`);
      }
    }
  });
});

describe('i18n: detección de credenciales en dos idiomas', () => {
  const CLASES = ['gcp-sa', 'aws-access-key', 'aws-temp', 'github-token', 'slack-token', 'azure-secret', 'pem', 'conn-string', 'env'];
  const MUESTRAS = {
    'aws-access-key': 'AKIAIOSFODNN7EXAMPLE',
    'aws-temp': 'ASIAIOSFODNN7EXAMPLE',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nx',
    'conn-string': 'postgres://a:b@h/db',
    env: 'A=1\nB=2',
  };

  it('cada tipo tiene kind, title y msg en español e inglés, distintos entre sí', () => {
    for (const c of CLASES) {
      const a = describeCred(c, 'es'), b = describeCred(c, 'en');
      for (const campo of ['kind', 'title', 'msg']) {
        assert.ok(a[campo] && b[campo], `${c}.${campo}`);
        assert.notEqual(a[campo], b[campo], `${c}.${campo} sin traducir`);
      }
      assert.equal(a.alt, b.alt, `${c}: el comando no se traduce`);
    }
  });

  it('detect() devuelve los textos del idioma pedido y español por defecto', () => {
    for (const [cls, texto] of Object.entries(MUESTRAS)) {
      assert.equal(detect(texto).cls, cls);
      assert.deepEqual(detect(texto), detect(texto, 'es'));
      assert.equal(detect(texto, 'en').title, describeCred(cls, 'en').title);
      assert.equal(detect(texto, 'en').cls, cls);
    }
    assert.equal(detect('AKIAIOSFODNN7EXAMPLE', 'en').kind, 'AWS access key');
    assert.equal(detect('AKIAIOSFODNN7EXAMPLE', 'es').kind, 'access key de AWS');
  });

  it('el idioma no cambia lo que se detecta ni los datos extraídos', () => {
    for (const texto of Object.values(MUESTRAS)) {
      const { kind, title, msg, ...es_ } = detect(texto, 'es');
      const { kind: k2, title: t2, msg: m2, ...en_ } = detect(texto, 'en');
      assert.deepEqual(en_, es_);
    }
  });

  it('un idioma desconocido cae en español', () => assert.equal(detect('AKIAIOSFODNN7EXAMPLE', 'fr').kind, 'access key de AWS'));
});
