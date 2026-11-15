import { openOuter, openInner } from './crypto.js';
const $ = (id) => document.getElementById(id);
const [id, key] = location.hash.slice(1).split(':');

function say(text, cls) { const m = $('msg'); m.textContent = text; m.className = cls; m.hidden = false; }
const uses = (n) => (n === 1 ? '1 uso' : `${n} usos`);
let held = null;   // capa interior en memoria, si hay passphrase: reintentar no gasta usos
let last = null;

function showRef(caseRef) {
  if (!caseRef) return;
  $('refLine').textContent = `Referencia indicada por el emisor (no verificada): ${caseRef}`;
  $('refLine').hidden = false;
}

// Antes de revelar: mostrar cuántos usos quedan, sin consumir ninguno
async function loadInfo() {
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/info`);
    if (r.status === 404) { $('reveal').hidden = true; return say('Este secreto no existe, ya se usó o expiró.', 'err'); }
    if (!r.ok) return;
    const d = await r.json();
    $('info').textContent = `Quedan ${uses(d.usesLeft)} de ${d.maxUses} en este link. Expira el ${new Date(d.expiresAt * 1000).toLocaleString()}.`;
    $('info').hidden = false;
    showRef(d.caseRef);
    if (d.pass) $('passBox').hidden = false;
  } catch { /* si falla, el botón sigue funcionando */ }
}

function present(text) {
  $('secret').textContent = text;       // textContent: nunca se interpreta como HTML
  $('secret').hidden = false;
  $('copy').hidden = false;
  $('copy').onclick = () => navigator.clipboard.writeText(text);
  $('reveal').hidden = true;
  $('passBox').hidden = true;
  $('info').hidden = true;
  say(last.usesLeft > 0
    ? `Usos restantes: ${last.usesLeft} de ${last.maxUses}. Puedes volver a abrir este link.`
    : `Era el último uso (${last.maxUses} de ${last.maxUses}). Este link ya no funciona.`, 'hint');
  if (last.usesLeft === 0) history.replaceState(null, '', location.pathname);
}

async function tryInner() {
  const p = $('pass').value;
  if (!p) return say('Escribe la passphrase.', 'err');
  $('reveal').disabled = true;
  try {
    const text = await openInner(held, p);
    held = null;
    present(text);
  } catch {
    say('Passphrase incorrecta. Puedes reintentar: no se gasta otro uso.', 'err');
    $('reveal').disabled = false;
  }
}

if (!id || !key) { $('reveal').hidden = true; say('Este link está incompleto.', 'err'); }
else loadInfo();

$('reveal').addEventListener('click', async () => {
  if (held) return tryInner();
  $('reveal').disabled = true;
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
    if (r.status === 404) return say('Este secreto no existe, ya se usó o expiró.', 'err');
    if (!r.ok) { $('reveal').disabled = false; return say('Error del servidor. Inténtalo de nuevo.', 'err'); }
    const data = await r.json();
    last = data;
    showRef(data.caseRef);
    let outer;
    try { outer = await openOuter({ ct: data.ct, iv: data.iv, key }); }
    catch { return say('No se pudo descifrar: el link está incompleto o dañado. Este intento sí consumió un uso.', 'err'); }

    if (data.pass) {
      held = outer;
      $('passBox').hidden = false;
      $('info').hidden = true;
      $('reveal').textContent = 'Descifrar con passphrase';
      $('reveal').disabled = false;
      say(`Usos restantes: ${data.usesLeft} de ${data.maxUses}. Escribe la passphrase y pulsa Descifrar; si te equivocas, puedes reintentar sin gastar otro uso.`, 'hint');
      if ($('pass').value) return tryInner();
      return;
    }
    present(outer);
  } catch {
    $('reveal').disabled = false;
    say('Error inesperado. Inténtalo de nuevo.', 'err');
  }
});
