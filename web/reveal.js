import { t, bind, locale } from './i18n.js';   // primero: traduce la página antes de que corra el resto
import { openOuter, openInner } from './crypto.js';
import { copyText, reducedMotion } from './ui.js';

const $ = (id) => document.getElementById(id);
const [id, key] = location.hash.slice(1).split(':');

let held = null;       // capa interior en memoria, si hay passphrase: reintentar no gasta usos
let last = null;       // última respuesta de /reveal
let countdown = null;  // temporizador de la cuenta atrás previa a revelar
let expiresAt = 0;

// Los textos quedan enlazados a su clave (bind): si cambia el idioma, se traducen solos.
function say(key, cls, params) {
  const m = $('msg');
  bind(m, key, params);
  m.className = cls;
  m.setAttribute('role', cls === 'err' ? 'alert' : 'status');
  m.hidden = false;
}

// Estado terminal: el link no sirve (no existe, usado, expirado o incompleto)
function gone(key) {
  clearInterval(countdown);
  $('reveal').hidden = true;
  $('meter').hidden = true;
  $('passBox').hidden = true;
  $('homeLink').hidden = false;
  say(key, 'err');
}

function showRef(caseRef) {
  if (!caseRef) return;
  bind($('refLine'), 'reveal.ref', { ref: caseRef });
  $('refLine').hidden = false;
}

// Etiqueta del botón principal (clave de traducción); busy() la sustituye mientras trabaja
let btnKey = 'reveal.btn';
function setBtn(key) { btnKey = key; bind($('reveal'), key); }
setBtn(btnKey);

// Botón principal ocupado: etiqueta "Descifrando…" y avión en movimiento
function busy(on) {
  const b = $('reveal');
  if (on) {
    bind(b, 'reveal.btn.busy');
    b.classList.add('loading');
    b.disabled = true;
  } else {
    b.classList.remove('loading');
    bind(b, btnKey);
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
  bind(box, 'reveal.dots', { n: left, max }, 'aria-label');
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
  if (s <= 0) return gone('reveal.expired');
  bind($('info'), 'reveal.info', { left: () => t('reveal.left', { n: left, max }), time: timeLeft(s) });
  bind($('info'), 'reveal.expiresOn', { date: () => new Date(expiresAt * 1000).toLocaleString(locale()) }, 'title');
}

// Antes de revelar: mostrar usos y tiempo restante, sin consumir ninguno
async function loadInfo() {
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/info`);
    if (r.status === 404) return gone('reveal.gone');
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
    say(last.usesLeft > 0 ? 'reveal.dissolved.more' : 'reveal.dissolved.last', 'hint');
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
    say('reveal.lastUse', 'hint');
    history.replaceState(null, '', location.pathname);
  } else {
    say('reveal.moreUses', 'hint');
  }
}

async function tryInner() {
  const p = $('pass').value;
  if (!p) return say('reveal.pass.empty', 'err');
  busy(true);
  try {
    const text = await openInner(held, p);
    held = null;
    present(text);
  } catch {
    say('reveal.pass.wrong', 'err');
    $('reveal').disabled = false;
  } finally {
    busy(false);
  }
}

if (!id || !key) gone('link.incomplete');
else loadInfo();

$('showPass').addEventListener('change', (e) => { $('pass').type = e.target.checked ? 'text' : 'password'; });
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('reveal').disabled) $('reveal').click(); });

$('reveal').addEventListener('click', async () => {
  if (held) return tryInner();
  busy(true);
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
    if (r.status === 404) return gone('reveal.gone');
    if (!r.ok) { $('reveal').disabled = false; return say('reveal.serverError', 'err'); }
    const data = await r.json();
    clearInterval(countdown);           // ya se consumió un uso: la cuenta atrás deja de aplicar
    last = data;
    showRef(data.caseRef);
    showUsage(data.usesLeft, data.maxUses, true);
    bind($('info'), 'reveal.left', { n: data.usesLeft, max: data.maxUses });
    bind($('info'), null, null, 'title');
    $('info').removeAttribute('title');
    let outer;
    try { outer = await openOuter({ ct: data.ct, iv: data.iv, key }); }
    catch { return say('reveal.decryptFail', 'err'); }

    if (data.pass) {
      held = outer;
      $('passBox').hidden = false;
      setBtn('reveal.btn.pass');
      $('reveal').disabled = false;
      say('reveal.pass.prompt', 'hint');
      $('pass').focus();
      if ($('pass').value) return await tryInner();
      return;
    }
    present(outer);
  } catch {
    $('reveal').disabled = false;
    say('reveal.unexpected', 'err');
  } finally {
    busy(false);
  }
});
