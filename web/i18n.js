// Internacionalización (es / en) sin dependencias. Cumple la CSP: sin scripts ni estilos en línea.
//
// Uso en el HTML (el texto en español queda como contenido inicial):
//   <h1 data-i18n="index.h1">…</h1>                       reemplaza el textContent
//   <input data-i18n-attr="placeholder:index.x;aria-label:index.y">   reemplaza atributos
// Uso en JS:
//   t(clave, params)               texto en el idioma actual
//   bind(el, clave, params, attr)  escribe el texto y lo vuelve a escribir si cambia el idioma
//                                  (attr = 'text' por defecto, o el nombre de un atributo)
//   onLangChange(cb)               para lo que no se resuelve con bind (listas, estado derivado)
//
// Un parámetro puede ser una función: se evalúa cada vez que se escribe el texto, así los valores
// que dependen del idioma (fechas, nombres de duración) siguen al idioma actual.
// Este módulo se aplica solo al importarse: basta con importarlo antes que el resto del script.
import { MESSAGES } from './messages.js';

export const LANGS = ['es', 'en'];
const LANG_NAMES = { es: 'Español', en: 'English' };
const STORAGE_KEY = 'cirrus.lang';

const store = {
  get() { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch { /* almacenamiento bloqueado: no se recuerda */ } },
};

// Prioridad: ?lang= (links de los correos), preferencia guardada, idioma del navegador, español.
function initialLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) { store.set(q); return q; }
  const saved = store.get();
  if (LANGS.includes(saved)) return saved;
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = String(l ?? '').toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'es';
}

let lang = initialLang();
const listeners = new Set();
const bindings = new Map();   // elemento -> Map(attr -> [clave, params])

export const getLang = () => lang;
// Código de localización para fechas y números
export const locale = () => lang;

export function t(key, params = {}) {
  const v = MESSAGES[lang]?.[key] ?? MESSAGES.es[key];
  if (v === undefined) return key;
  const p = {};
  for (const [k, val] of Object.entries(params ?? {})) p[k] = typeof val === 'function' ? val() : val;
  if (typeof v === 'function') return v(p);
  return v.replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
}

function write(el, attr, text) {
  if (attr === 'text') el.textContent = text;
  else el.setAttribute(attr, text);
}

// clave = null quita el enlace de ese atributo
export function bind(el, key, params, attr = 'text') {
  let m = bindings.get(el);
  if (key == null) { m?.delete(attr); return; }
  if (!m) { m = new Map(); bindings.set(el, m); }
  m.set(attr, [key, params]);
  write(el, attr, t(key, params));
}

export function onLangChange(cb) { listeners.add(cb); }

function translateDocument() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  for (const [el, attrs] of bindings) {
    if (!el.isConnected) { bindings.delete(el); continue; }
    for (const [attr, [key, params]] of attrs) write(el, attr, t(key, params));
  }
}

function syncSwitch() {
  for (const b of document.querySelectorAll('.lang-opt')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  store.set(lang);
  translateDocument();
  syncSwitch();
  for (const cb of listeners) cb(lang);
}

// Interruptor ES | EN al comienzo de la cabecera
function mountSwitch() {
  const header = document.querySelector('.site-header');
  if (!header || header.querySelector('.lang-switch')) return;
  const group = document.createElement('div');
  group.className = 'lang-switch';
  group.setAttribute('role', 'group');
  bind(group, 'lang.label', null, 'aria-label');
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang-opt';
    b.dataset.lang = l;
    b.lang = l;
    b.textContent = l.toUpperCase();
    b.setAttribute('aria-label', LANG_NAMES[l]);
    b.addEventListener('click', () => setLang(l));
    group.append(b);
  }
  header.prepend(group);
  syncSwitch();
}

translateDocument();
mountSwitch();
