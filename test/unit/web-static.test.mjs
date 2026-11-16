// Comprobaciones estáticas del frontend. Protegen las restricciones de la CSP de CloudFront
// (template.yaml) y la regla de no interpretar texto como HTML. No necesitan navegador.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const template = readFileSync(fileURLToPath(new URL('../../template.yaml', import.meta.url)), 'utf8');
const read = (f) => readFileSync(join(WEB, f), 'utf8');
const files = readdirSync(WEB);
const pages = files.filter((f) => f.endsWith('.html'));
const scripts = files.filter((f) => f.endsWith('.js'));
const csp = template.match(/ContentSecurityPolicy: "([^"]+)"/)?.[1] ?? '';

describe('CSP (template.yaml)', () => {
  it('existe y define las directivas que el frontend necesita', () => {
    assert.ok(csp, 'no se encontró la CSP');
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
      assert.ok(csp.includes(d), `falta ${d}`);
    }
  });
  it('no relaja la política con unsafe-inline ni unsafe-eval', () => {
    assert.doesNotMatch(csp, /unsafe-(inline|eval)/);
  });
});

describe('HTML compatible con la CSP', () => {
  for (const page of pages) {
    const html = read(page);
    describe(page, () => {
      it('sin <style> ni atributos style="" (style-src es solo \'self\')', () => {
        assert.doesNotMatch(html, /<style[\s>]/i);
        assert.doesNotMatch(html, /\sstyle\s*=/i);
      });
      it('sin scripts en línea ni manejadores on*= (script-src es solo \'self\')', () => {
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
        assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
      });
      it('todo recurso local referenciado existe', () => {
        for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
          if (/^(https?:|mailto:|data:|#|\/$)/.test(ref)) continue;
          const archivo = ref.split(/[?#]/)[0];
          assert.ok(existsSync(join(WEB, archivo)), `${page} referencia ${ref}, que no existe`);
        }
      });
      it('declara idioma, viewport, título y esquema de color claro', () => {
        assert.match(html, /<html lang="es">/);
        assert.match(html, /<meta name="viewport"/);
        assert.match(html, /<title[^>]*>[^<]+<\/title>/);
        assert.match(html, /<meta name="color-scheme" content="light">/);
      });
      it('comparte la cabecera con logo y el pie', () => {
        assert.match(html, /<header class="site-header">/);
        assert.match(html, /<footer class="site-footer">/);
      });
    });
  }
});

describe('CSS', () => {
  const css = read('style.css');
  it('todo url() local existe (fuentes, iconos)', () => {
    for (const [, ref] of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
      if (ref.startsWith('data:')) continue;
      assert.ok(existsSync(join(WEB, ref)), `style.css referencia ${ref}, que no existe`);
    }
  });
  it('el atributo hidden siempre gana, aunque un componente defina su propio display', () => {
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
  it('respeta prefers-reduced-motion', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
  it('es solo tema claro: no hay modo oscuro', () => {
    assert.match(css, /color-scheme:\s*light/);
    assert.doesNotMatch(css, /prefers-color-scheme|data-theme/);
  });
});

describe('JavaScript del navegador', () => {
  it('hay scripts que revisar', () => assert.ok(scripts.length >= 8));

  for (const f of scripts) {
    it(`${f}: nunca interpreta texto como HTML ni ejecuta código dinámico`, () => {
      const src = read(f);
      assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=/, 'asignación a innerHTML/outerHTML');
      assert.doesNotMatch(src, /insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/);
      assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, 'setAttribute("style") lo bloquea la CSP');
    });
  }

  it('el secreto y la clave nunca viajan al servidor: la clave solo vive en el fragmento # del link', () => {
    const idx = read('index.js');
    assert.match(idx, /#\$\{data\.id\}:\$\{key\}/);                       // el link lleva la clave tras el #
    assert.doesNotMatch(idx, /body\.(key|text|secret)\s*=/);                // la clave y el texto no se añaden al cuerpo
    assert.match(idx, /encrypt\(text, pass \|\| undefined\)/);              // se cifra en el navegador antes de enviar
  });
});
