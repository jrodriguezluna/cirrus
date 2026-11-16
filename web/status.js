const $ = (id) => document.getElementById(id);
const [id, token] = location.hash.slice(1).split(':');
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '—');

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

function headline(d, { fullyRead, expired }) {
  if (d.status === 'ACKED') return ['ok', 'Rotación confirmada. Ciclo cerrado.'];
  if (d.status === 'GAVE_UP') return ['err', 'Sin confirmar tras 3 recordatorios: la credencial podría seguir activa.'];
  if (fullyRead) {
    if (tracksRotation(d)) return ['err', 'Leído por completo. Rotación pendiente de confirmación.'];
    return ['hint', d.notify ? 'Leído por completo. Te avisamos por email.' : 'Leído por completo. No hay seguimiento activo.'];
  }
  if (expired && d.reads > 0) {
    const base = `Expiró y se leyó ${d.reads} de ${d.maxUses} veces.`;
    if (tracksRotation(d)) return ['err', `${base} Rotación pendiente de confirmación.`];
    return ['hint', d.notify ? `${base} Te avisamos por email.` : base];
  }
  if (expired) return ['hint', 'Expiró sin que nadie lo leyera.'];
  if (d.reads > 0) return ['hint', `En uso: ${d.reads} de ${d.maxUses} lecturas.`];
  return ['hint', 'Creado, todavía nadie lo ha leído.'];
}

// Pasos del progreso: Creado → Leído → Rotado (o Cerrado si no hay seguimiento)
function steps(d, { fullyRead, expired }) {
  const read = d.reads > 0;
  const count = `${d.reads} de ${d.maxUses}`;
  const out = [{ label: 'Creado', sub: when(d.createdAt), state: 'done' }];

  if (fullyRead || (expired && read)) out.push({ label: 'Leído', sub: count, state: 'done' });
  else if (expired) out.push({ label: 'Sin leer', sub: 'Expiró', state: 'warn' });
  else out.push({ label: 'Leído', sub: read ? count : 'Esperando', state: 'current' });

  if (tracksRotation(d)) {
    if (d.status === 'ACKED') out.push({ label: 'Rotado', sub: 'Confirmado', state: 'done' });
    else if (d.status === 'GAVE_UP') out.push({ label: 'Rotado', sub: 'Sin confirmar', state: 'warn' });
    else if (fullyRead || (expired && read)) out.push({ label: 'Rotado', sub: `Recordatorios ${d.attempts} de 3`, state: 'current' });
    else if (expired) out.push({ label: 'Cerrado', sub: 'Sin recordatorios', state: 'done' });
    else out.push({ label: 'Rotado', sub: 'Pendiente', state: 'pending' });
  } else if (fullyRead || expired) {
    out.push({ label: 'Cerrado', sub: fullyRead ? 'Usos agotados' : 'Expirado', state: 'done' });
  } else {
    out.push({ label: 'Cerrado', sub: 'Pendiente', state: 'pending' });
  }
  return out;
}

// ¿Ya no habrá más cambios que mostrar?
function finished(d, { fullyRead, expired }) {
  if (d.status === 'ACKED' || d.status === 'GAVE_UP') return true;
  if (!tracksRotation(d)) return fullyRead || expired;
  return expired && d.reads === 0;     // sin lecturas no habrá recordatorios
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderSteps(list) {
  const ol = $('stepper');
  ol.replaceChildren(...list.map((s, i) => {
    const li = el('li', `step ${s.state}`);
    li.append(el('span', 'mark', s.state === 'done' ? '' : s.state === 'warn' ? '!' : String(i + 1)));
    li.append(el('span', 'label', s.label), el('span', 'sub', s.sub));
    if (s.state === 'current') li.setAttribute('aria-current', 'step');
    return li;
  }));
  ol.hidden = false;
}

function row(dl, k, v) {
  dl.append(el('dt', '', k), el('dd', '', v));
}

function renderDetails(d) {
  const dl = $('stat');
  dl.replaceChildren();
  if (d.caseRef) row(dl, 'Referencia', d.caseRef);
  row(dl, 'Lecturas', `${d.reads} de ${d.maxUses}`);
  (d.readLog ?? []).forEach((t, i) => row(dl, `Lectura ${i + 1}`, when(t)));
  row(dl, 'Creado', when(d.createdAt));
  row(dl, 'Expira', when(d.expiresAt));
  if (tracksRotation(d)) row(dl, 'Recordatorios', `${d.attempts} de 3`);
  dl.hidden = false;
}

function live(text, on) {
  $('liveText').textContent = text;
  $('live').classList.toggle('off', !on);
  $('live').hidden = false;
}

let timer;
let lastSig = '';

function stop(text) {
  clearInterval(timer);
  live(text, false);
}

async function load() {
  let r;
  try {
    r = await fetch(`/api/secrets/${encodeURIComponent(id)}/status`, { headers: { 'X-Status-Token': token } });
  } catch {
    live('Sin conexión, reintentando…', false);
    return;
  }
  if (!r.ok) {
    $('headline').className = 'err';
    $('headline').textContent = 'No se encontró este secreto o el link es inválido.';
    clearInterval(timer);
    return;
  }
  const d = await r.json();
  const x = derive(d);

  // Solo se vuelve a pintar si algo cambió: así las animaciones no se reinician en cada sondeo
  const sig = JSON.stringify([d, x.fullyRead, x.expired]);
  if (sig !== lastSig) {
    lastSig = sig;
    const [cls, text] = headline(d, x);
    $('headline').className = cls;
    $('headline').textContent = text;
    renderSteps(steps(d, x));
    renderDetails(d);
  }
  if (finished(d, x)) stop('Sin cambios pendientes: ya no se actualiza.');
  else live('Se actualiza solo cada 5 segundos.', true);
}

if (!id || !token) {
  $('headline').className = 'err';
  $('headline').textContent = 'Este link está incompleto.';
} else {
  load();
  timer = setInterval(load, 5000);
}
