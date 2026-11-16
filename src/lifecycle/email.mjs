// Presentación de los correos. Un mismo modelo de bloques produce el texto plano y el HTML,
// así las dos versiones no pueden desincronizarse.
//
// El HTML usa solo lo que los clientes de correo respetan: tablas y estilos en línea. Sin imágenes,
// sin fuentes web ni recursos externos (se bloquean por defecto; el SVG no funciona en Gmail/Outlook).
// Todo valor interpolado se escapa con esc(): los datos del emisor (referencia, ids) nunca se
// insertan como HTML.
//
// Bloques:
//   { type: 'ref', value }                        referencia indicada por el emisor
//   { type: 'p', text }                           párrafo
//   { type: 'alert', text }                       aviso destacado
//   { type: 'reads', items: [fechas] }            historial de lecturas
//   { type: 'steps', title, items: [{ text, code? }] }   lista numerada, con comandos opcionales
//   { type: 'action', intro, label, url }         botón de acción (con el link visible debajo)
//
// El modelo lleva además `lang` ('es' | 'en', por defecto 'es'): fija las etiquetas fijas del
// correo (Referencia, Lecturas, pie…) y el atributo lang del HTML. El resto del texto ya llega traducido.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Paleta de la web (contrastes >= 4.5:1)
const C = { ink: '#223048', muted: '#5a6a80', sky: '#e3effd', card: '#ffffff', soft: '#f3f8fe', accent: '#2a6fdb', info: '#1b3d85', warnBg: '#fff4de', warnFg: '#6b4200' };
const FONT = "Nunito, 'Trebuchet MS', 'Segoe UI', Arial, sans-serif";
const MONO = "Consolas, Menlo, 'Courier New', monospace";

const LABELS = {
  es: {
    ref: 'Referencia', reads: 'Lecturas',
    fallback: 'Si el botón no funciona, copia este link',
    footer: 'Enviado por Cirrus. Los secretos se cifran en tu navegador: el servidor nunca los ve.',
  },
  en: {
    ref: 'Reference', reads: 'Reads',
    fallback: 'If the button does not work, copy this link',
    footer: 'Sent by Cirrus. Secrets are encrypted in your browser: the server never sees them.',
  },
};
const known = (lang) => (Object.hasOwn(LABELS, lang) ? lang : 'es');

// Cada generador recibe el bloque y las etiquetas del idioma
const TEXT = {
  ref: (b, L) => `${L.ref}: ${b.value}`,
  p: (b) => b.text,
  alert: (b) => b.text,
  reads: (b, L) => [`${L.reads}:`, ...b.items.map((d, i) => `  ${i + 1}) ${d}`)].join('\n'),
  steps: (b) => [`${b.title}:`, ...b.items.map((s, i) => `${i + 1}. ${s.text}${s.code ? `\n   ${s.code.split('\n').join('\n   ')}` : ''}`)].join('\n'),
  action: (b) => `${b.intro}\n  ${b.url}`,
};

const HTML = {
  ref: (b, L) => `<p style="margin:0 0 16px;"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${C.sky};color:${C.info};font-size:13px;font-weight:700;">${esc(L.ref)}: ${esc(b.value)}</span></p>`,
  p: (b) => `<p style="margin:0 0 16px;">${esc(b.text)}</p>`,
  alert: (b) => `<div style="margin:0 0 16px;padding:12px 14px;border-radius:10px;background:${C.warnBg};color:${C.warnFg};font-weight:700;">${esc(b.text)}</div>`,
  reads: (b, L) => `<p style="margin:0 0 6px;font-weight:700;">${esc(L.reads)}</p>`
    + `<ul style="margin:0 0 16px;padding-left:20px;color:${C.muted};">${b.items.map((d) => `<li style="margin:0 0 2px;">${esc(d)}</li>`).join('')}</ul>`,
  steps: (b) => `<p style="margin:0 0 6px;font-weight:700;">${esc(b.title)}</p>`
    + `<ol style="margin:0 0 16px;padding-left:22px;">${b.items.map((s) => `<li style="margin:0 0 10px;">${esc(s.text)}`
      + (s.code ? `<pre style="margin:6px 0 0;padding:8px 10px;border-radius:8px;background:${C.soft};color:${C.ink};font:13px/1.45 ${MONO};white-space:pre-wrap;word-break:break-all;">${esc(s.code)}</pre>` : '')
      + '</li>').join('')}</ol>`,
  action: (b, L) => `<p style="margin:0 0 14px;">${esc(b.intro)}</p>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr><td style="border-radius:999px;background:${C.accent};">`
    + `<a href="${esc(b.url)}" style="display:inline-block;padding:12px 24px;border-radius:999px;color:#ffffff;font:800 16px ${FONT};text-decoration:none;">${esc(b.label)}</a>`
    + '</td></tr></table>'
    + `<p style="margin:0;font-size:12px;color:${C.muted};word-break:break-all;">${esc(L.fallback)}: ${esc(b.url)}</p>`,
};

// -> { text, html }
export function render({ lang = 'es', heading, blocks }) {
  const htmlLang = known(lang);
  const L = LABELS[htmlLang];
  const text = blocks.map((b) => TEXT[b.type](b, L)).join('\n\n').trimEnd();
  const preheader = blocks.find((b) => b.type === 'p')?.text ?? heading;
  const html = [
    '<!doctype html>',
    `<html lang="${htmlLang}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">',
    `<title>${esc(heading)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.sky};">`,
    // Texto de vista previa (lo que muestra la bandeja de entrada junto al asunto)
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.sky};">${esc(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sky};"><tr><td align="center" style="padding:24px 12px;">`,
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">',
    `<tr><td align="center" style="padding:4px 0 16px;font:800 30px/1 ${FONT};color:${C.ink};letter-spacing:-0.5px;">Cirrus</td></tr>`,
    `<tr><td style="padding:28px;border-radius:16px;background:${C.card};color:${C.ink};font:16px/1.55 ${FONT};">`,
    `<h1 style="margin:0 0 16px;font:800 22px/1.25 ${FONT};color:${C.ink};">${esc(heading)}</h1>`,
    blocks.map((b) => HTML[b.type](b, L)).join(''),
    '</td></tr>',
    `<tr><td align="center" style="padding:16px 8px 0;font:12px/1.5 ${FONT};color:${C.muted};">${esc(L.footer)}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
  return { text, html };
}
