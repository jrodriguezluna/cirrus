// Utilidades de interfaz compartidas por las páginas.
import { t, bind } from './i18n.js';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Método clásico, por si la API moderna del portapapeles está bloqueada.
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'offscreen';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* sin soporte */ }
  ta.remove();
  return ok;
}

// Cambia el texto del botón un instante y luego lo restaura. El botón conserva su clave de
// traducción (data-i18n), así que se restaura en el idioma vigente, aunque cambie durante el aviso.
function flash(btn, key, cls) {
  const original = btn.dataset.i18n;
  bind(btn, key);
  btn.classList.add(cls);
  clearTimeout(btn.flashTimer);
  btn.flashTimer = setTimeout(() => {
    bind(btn, null);                                   // deja de seguir el aviso
    btn.textContent = t(original);
    btn.classList.remove(cls);
  }, 1800);
}

// Copia al portapapeles y confirma en el propio botón ("¡Copiado!" / "Copied!").
// El botón debe llevar data-i18n con su texto normal.
// Si ningún método funciona, avisa y ejecuta `onFail` (p. ej. seleccionar el texto para copiarlo a mano).
export async function copyText(btn, text, { onFail } = {}) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = legacyCopy(text); }
  if (ok) flash(btn, 'copied', 'done');
  else { onFail?.(); flash(btn, 'copyManual', 'failed'); }
  return ok;
}

// Lanza la animación del avión (imagen decorativa ya presente en la página).
// `variant` es el nombre de la clase de animación definida en style.css.
export function flyPlane(id = 'flyPlane', variant = 'fly') {
  const el = document.getElementById(id);
  if (!el || reducedMotion()) return;
  el.hidden = false;
  el.classList.remove(variant);
  void el.offsetWidth;                 // reinicia la animación si ya se había ejecutado
  el.classList.add(variant);
  el.addEventListener('animationend', () => { el.hidden = true; el.classList.remove(variant); }, { once: true });
}
