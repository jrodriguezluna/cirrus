// Utilidades de interfaz compartidas por las páginas.

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

// Cambia el texto del botón un instante y luego lo restaura.
function flash(btn, label, cls) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn.classList.add(cls);
  clearTimeout(btn.flashTimer);
  btn.flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove(cls);
  }, 1800);
}

// Copia al portapapeles y confirma en el propio botón ("¡Copiado!").
// Si ningún método funciona, avisa y ejecuta `onFail` (p. ej. seleccionar el texto para copiarlo a mano).
export async function copyText(btn, text, { onFail } = {}) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = legacyCopy(text); }
  if (ok) flash(btn, '¡Copiado!', 'done');
  else { onFail?.(); flash(btn, 'Cópialo con Ctrl+C', 'failed'); }
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
