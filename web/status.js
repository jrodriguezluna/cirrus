import { bind, locale } from './i18n.js';   // primero: traduce la página antes de que corra el resto

const $ = (id) => document.getElementById(id);
const [id, token] = location.hash.slice(1).split(':');
const when = (s) => (s ? new Date(s * 1000).toLocaleString(locale()) : '—');
// Fecha como valor de un texto enlazado: se vuelve a formatear si cambia el idioma
const date = (s) => ['status.date', { date: () => when(s) }];
const count = (d) => ['status.count', { n: d.reads, max: d.maxUses }];

// Todos los textos se enlazan a una clave de traducción (bind): si cambia el idioma, se escriben
// de nuevo solos, sin repetir la lógica de estado. Un texto es [clave, parámetros].

// ¿Hay ciclo de rotación (checklist, recordatorios, confirmación)? Solo si hay seguimiento por email
// y el emisor pidió rotación. Una API anterior sin `rotate` se interpreta como con rotación.
const tracksRotation = (d) => Boolean(d.notify) && d.rotate !== false;

// Deriva el estado real. Sin seguimiento por email el servidor nunca actualiza `status`
// (queda en CREATED), así que "leído por completo" y "expirado" se infieren de los contadores.
function derive(d) {
  const now = Math.floor(Date.now() / 1000);
  const fullyRead = d.reads >= d.maxUses || d.status === 'READ';
  // Mismo criterio que el backend (reveal exige expiresAt > now): vencido cuando expiresAt <= now
  const expired = d.status === 'EXPIRED' || (!fullyRead && Boolean(d.expiresAt) && d.expiresAt <= now);
  return { fullyRead, expired };
}

// -> [clase, clave, parámetros]
function headline(d, { fullyRead, expired }) {
  if (d.status === 'ACKED') return ['ok', 'status.h.acked'];
  if (d.status === 'GAVE_UP') return ['err', 'status.h.gaveUp'];
  if (fullyRead) {
    if (tracksRotation(d)) return ['err', 'status.h.fullRot'];
    return ['hint', d.notify ? 'status.h.fullMail' : 'status.h.fullNone'];
  }
  if (expired && d.reads > 0) {
    const p = { reads: d.reads, max: d.maxUses };
    if (tracksRotation(d)) return ['err', 'status.h.expReadRot', p];
    return ['hint', d.notify ? 'status.h.expReadMail' : 'status.h.expRead', p];
  }
  if (expired) return ['hint', 'status.h.expUnread'];
  if (d.reads > 0) return ['hint', 'status.h.inUse', { reads: d.reads, max: d.maxUses }];
  return ['hint', 'status.h.created'];
}

// Pasos del progreso: Creado → Leído → Rotado (o Cerrado si no hay seguimiento)
// Cada paso: { label: clave, sub: [clave, parámetros], state }
function steps(d, { fullyRead, expired }) {
  const read = d.reads > 0;
  const out = [{ label: 'status.s.created', sub: date(d.createdAt), state: 'done' }];

  if (fullyRead || (expired && read)) out.push({ label: 'status.s.read', sub: count(d), state: 'done' });
  else if (expired) out.push({ label: 'status.s.unread', sub: ['status.sub.expired'], state: 'warn' });
  else out.push({ label: 'status.s.read', sub: read ? count(d) : ['status.sub.waiting'], state: 'current' });

  if (tracksRotation(d)) {
    if (d.status === 'ACKED') out.push({ label: 'status.s.rotated', sub: ['status.sub.confirmed'], state: 'done' });
    else if (d.status === 'GAVE_UP') out.push({ label: 'status.s.rotated', sub: ['status.sub.unconfirmed'], state: 'warn' });
    else if (fullyRead || (expired && read)) out.push({ label: 'status.s.rotated', sub: ['status.sub.reminders', { n: d.attempts }], state: 'current' });
    else if (expired) out.push({ label: 'status.s.closed', sub: ['status.sub.noReminders'], state: 'done' });
    else out.push({ label: 'status.s.rotated', sub: ['status.sub.pending'], state: 'pending' });
  } else if (fullyRead || expired) {
    out.push({ label: 'status.s.closed', sub: [fullyRead ? 'status.sub.exhausted' : 'status.sub.expiredShort'], state: 'done' });
  } else {
    out.push({ label: 'status.s.closed', sub: ['status.sub.pending'], state: 'pending' });
  }
  return out;
}

// ¿Ya no habrá más cambios que mostrar?
function finished(d, { fullyRead, expired }) {
  if (d.status === 'ACKED' || d.status === 'GAVE_UP') return true;
  if (!tracksRotation(d)) return fullyRead || expired;
  return expired && d.reads === 0;     // sin lecturas no habrá recordatorios
}

// Elemento con texto fijo (cls, text) o enlazado a una clave (text = [clave, parámetros])
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (Array.isArray(text)) bind(e, text[0], text[1]);
  else if (text !== undefined) e.textContent = text;
  return e;
}

function renderSteps(list) {
  const ol = $('stepper');
  ol.replaceChildren(...list.map((s, i) => {
    const li = el('li', `step ${s.state}`);
    li.append(el('span', 'mark', s.state === 'done' ? '' : s.state === 'warn' ? '!' : String(i + 1)));
    li.append(el('span', 'label', [s.label]), el('span', 'sub', s.sub));
    if (s.state === 'current') li.setAttribute('aria-current', 'step');
    return li;
  }));
  ol.hidden = false;
}

// k: [clave, parámetros]; v: texto literal (dato del emisor) o [clave, parámetros]
function row(dl, k, v) {
  dl.append(el('dt', '', k), el('dd', '', v));
}

function renderDetails(d) {
  const dl = $('stat');
  dl.replaceChildren();
  if (d.caseRef) row(dl, ['status.d.ref'], d.caseRef);
  row(dl, ['status.d.reads'], count(d));
  (d.readLog ?? []).forEach((s, i) => row(dl, ['status.d.read', { n: i + 1 }], date(s)));
  row(dl, ['status.s.created'], date(d.createdAt));
  row(dl, ['status.d.expires'], date(d.expiresAt));
  if (tracksRotation(d)) row(dl, ['status.d.reminders'], ['status.d.reminderCount', { n: d.attempts }]);
  dl.hidden = false;
}

function live(key, on) {
  bind($('liveText'), key);
  $('live').classList.toggle('off', !on);
  $('live').hidden = false;
}

let timer;
let lastSig = '';

function stop(key) {
  clearInterval(timer);
  live(key, false);
}

function problem(key) {
  $('headline').className = 'err';
  bind($('headline'), key);
}

async function load() {
  let r;
  try {
    r = await fetch(`/api/secrets/${encodeURIComponent(id)}/status`, { headers: { 'X-Status-Token': token } });
  } catch {
    live('status.live.offline', false);
    return;
  }
  if (!r.ok) {
    problem('status.notFound');
    clearInterval(timer);
    return;
  }
  const d = await r.json();
  const x = derive(d);

  // Solo se vuelve a pintar si algo cambió: así las animaciones no se reinician en cada sondeo
  const sig = JSON.stringify([d, x.fullyRead, x.expired]);
  if (sig !== lastSig) {
    lastSig = sig;
    const [cls, key, params] = headline(d, x);
    $('headline').className = cls;
    bind($('headline'), key, params);
    renderSteps(steps(d, x));
    renderDetails(d);
  }
  if (finished(d, x)) stop('status.live.off');
  else live('status.live.on', true);
}

if (!id || !token) {
  problem('link.incomplete');
} else {
  bind($('headline'), 'status.loading');
  load();
  timer = setInterval(load, 5000);
}
