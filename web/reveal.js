import { decrypt } from './crypto.js';
const $ = (id) => document.getElementById(id);
const [id, key] = location.hash.slice(1).split(':');

function say(text, cls) { const m = $('msg'); m.textContent = text; m.className = cls; m.hidden = false; }

if (!id || !key) { $('reveal').hidden = true; say('Este link está incompleto.', 'err'); }

$('reveal').addEventListener('click', async () => {
  $('reveal').disabled = true;
  try {
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
    if (r.status === 404) return say('Este secreto no existe, ya se usó o expiró.', 'err');
    if (!r.ok) { $('reveal').disabled = false; return say('Error del servidor. Inténtalo de nuevo.', 'err'); }
    const data = await r.json();
    let text;
    try { text = await decrypt({ ct: data.ct, iv: data.iv, key }); }
    catch { return say('No se pudo descifrar: el link está incompleto o dañado. Este intento sí consumió un uso.', 'err'); }

    $('secret').textContent = text;       // textContent: nunca se interpreta como HTML
    $('secret').hidden = false;
    $('copy').hidden = false;
    $('copy').onclick = () => navigator.clipboard.writeText(text);
    $('reveal').hidden = true;
    say(`Usos restantes: ${data.usesLeft} de ${data.maxUses}.`, 'hint');
    if (data.usesLeft === 0) history.replaceState(null, '', location.pathname);
  } catch {
    $('reveal').disabled = false;
    say('Error inesperado. Inténtalo de nuevo.', 'err');
  }
});
