import { openOuter, openInner } from './crypto.js';
import { copyText, reducedMotion } from './ui.js';

const $ = (id) => document.getElementById(id);
const [id, key] = location.hash.slice(1).split(':');

const uses = (n) => (n === 1 ? '1 uso' : `${n} usos`);
const remaining = (n, max) => `${n === 1 ? 'Queda' : 'Quedan'} ${uses(n)} de ${max}`;
let held = null;       // capa interior en memoria, si hay passphrase: reintentar no gasta usos
let last = null;       // última respuesta de /reveal
let countdown = null;  // temporizador de la cuenta atrás previa a revelar
let expiresAt = 0;

function say(text, cls) {
  const m = $('msg');
  m.textContent = text;
  m.className = cls;
  m.setAttribute('role', cls === 'err' ? 'alert' : 'status');
  m.hidden = false;
}

// Estado terminal: el link no sirve (no existe, usado, expirado o incompleto)
function gone(text) {
  clearInterval(countdown);
  $('reveal').hidden = true;
  $('meter').hidden = true;
  $('passBox').hidden = true;
  $('homeLink').hidden = false;
  say(text, 'err');
}

function showRef(caseRef) {
  if (!caseRef) return;
  $('refLine').textContent = `Referencia indicada por el emisor (no verificada): ${caseRef}`;
  $('refLine').hidden = false;
}

// Botón principal ocupado: etiqueta "Descifrando…" y avión en movimiento
function busy(on) {
  const b = $('reveal');
  if (on) {
    b.dataset.prev = b.textContent;
    b.textContent = 'Descifrando…';
    b.classList.add('loading');
    b.disabled = true;
  } else {
    b.classList.remove('loading');
    if (b.textContent === 'Descifrando…') b.textContent = b.dataset.prev;
  }
}

// Puntos de usos: rellenos = disponibles. `spendOne` anima el que se acaba de gastar.
function showUsage(left, max, spendOne = false) {
  const box = $('dots');
  box.replaceChildren();
  for (let i = 0; i < max; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i < left ? ' on' : '');
    if (spendOne && i === left) dot.classList.add('spent');
    box.appendChild(dot);
  }
  box.setAttribute('aria-label', `${left === 1 ? '1 uso disponible' : `${left} usos disponibles`} de ${max}`);
  $('meter').hidden = false;
}

function timeLeft(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m >= 5) return `${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

function tick(left, max) {
  const s = expiresAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return gone('Este secreto expiró.');
  $('info').textContent = `${remaining(left, max)} · Expira en ${timeLeft(s)}`;
  $('info').title = `Expira el ${new Date(expiresAt * 1000).toLocaleString()}`;
}

// Antes de revelar: mostrar usos y tiempo restante, sin consumir ninguno
async function loadInfo() {
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/info`);
    if (r.status === 404) return gone('Este secreto no existe, ya se usó o expiró.');
    if (!r.ok) return;
    const d = await r.json();
    expiresAt = d.expiresAt;
    showUsage(d.usesLeft, d.maxUses);
    tick(d.usesLeft, d.maxUses);
    countdown = setInterval(() => tick(d.usesLeft, d.maxUses), 1000);
    showRef(d.caseRef);
    if (d.pass) $('passBox').hidden = false;
  } catch { /* si falla, el botón sigue funcionando */ }
}

function selectSecret() {
  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents($('secret'));
  sel.addRange(range);
}

// Quita el secreto de la pantalla (con efecto de disolución si el usuario lo permite)
function dissolve() {
  const el = $('secret');
  const finish = () => {
    el.textContent = '';
    el.hidden = true;
    el.classList.remove('dissolve');
    $('actions').hidden = true;
    $('copy').onclick = null;
    say(last.usesLeft > 0
      ? 'El secreto se disipó de esta pantalla. Puedes volver a abrir el link mientras queden usos.'
      : 'El secreto se disipó de esta pantalla. Este link ya no funciona.', 'hint');
  };
  if (reducedMotion()) return finish();
  el.classList.add('dissolve');
  el.addEventListener('animationend', finish, { once: true });
}

function present(text) {
  $('secret').textContent = text;       // textContent: nunca se interpreta como HTML
  $('secret').hidden = false;
  $('actions').hidden = false;
  $('copy').onclick = () => copyText($('copy'), text, { onFail: selectSecret });
  $('dissolve').onclick = dissolve;
  $('reveal').hidden = true;
  $('passBox').hidden = true;
  if (last.usesLeft === 0) {
    say('Era el último uso: este link ya no funciona. Copia el secreto ahora, desaparece al cerrar o recargar la página.', 'hint');
    history.replaceState(null, '', location.pathname);
  } else {
    say('Puedes volver a abrir este link mientras queden usos.', 'hint');
  }
}

async function tryInner() {
  const p = $('pass').value;
  if (!p) return say('Escribe la passphrase.', 'err');
  busy(true);
  try {
    const text = await openInner(held, p);
    held = null;
    present(text);
  } catch {
    say('Passphrase incorrecta. Puedes reintentar: no se gasta otro uso.', 'err');
    $('reveal').disabled = false;
  } finally {
    busy(false);
  }
}

if (!id || !key) gone('Este link está incompleto.');
else loadInfo();

$('showPass').addEventListener('change', (e) => { $('pass').type = e.target.checked ? 'text' : 'password'; });
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('reveal').disabled) $('reveal').click(); });

$('reveal').addEventListener('click', async () => {
  if (held) return tryInner();
  busy(true);
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
    if (r.status === 404) return gone('Este secreto no existe, ya se usó o expiró.');
    if (!r.ok) { $('reveal').disabled = false; return say('Error del servidor. Inténtalo de nuevo.', 'err'); }
    const data = await r.json();
    clearInterval(countdown);           // ya se consumió un uso: la cuenta atrás deja de aplicar
    last = data;
    showRef(data.caseRef);
    showUsage(data.usesLeft, data.maxUses, true);
    $('info').textContent = remaining(data.usesLeft, data.maxUses);
    $('info').removeAttribute('title');
    let outer;
    try { outer = await openOuter({ ct: data.ct, iv: data.iv, key }); }
    catch { return say('No se pudo descifrar: el link está incompleto o dañado. Este intento sí consumió un uso.', 'err'); }

    if (data.pass) {
      held = outer;
      $('passBox').hidden = false;
      $('reveal').textContent = 'Descifrar con passphrase';
      $('reveal').disabled = false;
      say('Escribe la passphrase y pulsa Descifrar; si te equivocas, puedes reintentar sin gastar otro uso.', 'hint');
      $('pass').focus();
      if ($('pass').value) return await tryInner();
      return;
    }
    present(outer);
  } catch {
    $('reveal').disabled = false;
    say('Error inesperado. Inténtalo de nuevo.', 'err');
  } finally {
    busy(false);
  }
});
