const $ = (id) => document.getElementById(id);
const [id, token] = location.hash.slice(1).split(':');
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '—');

function headline(d) {
  const now = Math.floor(Date.now() / 1000);
  const expired = d.status === 'EXPIRED' || (d.status === 'CREATED' && d.expiresAt && d.expiresAt < now);
  if (d.status === 'ACKED') return ['ok', 'Rotación confirmada. Ciclo cerrado.'];
  if (d.status === 'GAVE_UP') return ['err', 'Sin confirmar tras 3 recordatorios: la credencial podría seguir activa.'];
  if (d.status === 'READ') return ['err', d.notify ? 'Leído por completo. Rotación pendiente.' : 'Leído por completo.'];
  if (expired && d.reads > 0) return ['err', `Expiró y se leyó ${d.reads} de ${d.maxUses} veces.` + (d.notify ? ' Rotación pendiente.' : '')];
  if (expired) return ['hint', 'Expiró sin que nadie lo leyera.'];
  if (d.reads > 0) return ['hint', `En uso: ${d.reads} de ${d.maxUses} lecturas.`];
  return ['hint', 'Creado, todavía nadie lo ha leído.'];
}

function row(dl, k, v) {
  const a = document.createElement('dt'); a.textContent = k;
  const b = document.createElement('dd'); b.textContent = v;
  dl.append(a, b);
}

let timer;
async function load() {
  const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/status`, { headers: { 'X-Status-Token': token } });
  if (!r.ok) { $('headline').className = 'err'; $('headline').textContent = 'No se encontró este secreto o el link es inválido.'; clearInterval(timer); return; }
  const d = await r.json();
  const [cls, text] = headline(d);
  $('headline').className = cls;
  $('headline').textContent = text;
  const dl = $('stat'); dl.replaceChildren(); dl.hidden = false;
  if (d.caseRef) row(dl, 'Referencia', d.caseRef);
  row(dl, 'Lecturas', `${d.reads} de ${d.maxUses}`);
  (d.readLog ?? []).forEach((t, i) => row(dl, `Lectura ${i + 1}`, when(t)));
  row(dl, 'Creado', when(d.createdAt));
  row(dl, 'Expira', when(d.expiresAt));
  if (d.notify) row(dl, 'Recordatorios', `${d.attempts} de 3`);
  if (d.status === 'ACKED' || d.status === 'GAVE_UP') clearInterval(timer);
}

if (!id || !token) { $('headline').className = 'err'; $('headline').textContent = 'Este link está incompleto.'; }
else { load(); timer = setInterval(load, 5000); }
