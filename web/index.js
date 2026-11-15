import { encrypt } from './crypto.js';
import { detect } from './detect.js';

const $ = (id) => document.getElementById(id);
let ttlTouched = false;
$('ttl').addEventListener('change', () => { ttlTouched = true; });

function line(parent, tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function refresh() {
  const d = detect($('secret').value);
  const box = $('detect');
  box.replaceChildren();
  if (!d) {
    box.hidden = true;
    if (!ttlTouched) $('ttl').value = '86400';
    return;
  }
  box.hidden = false;
  box.className = `box ${d.level}`;
  line(box, 'strong', d.title);
  line(box, 'span', d.msg);
  if (d.alt) line(box, 'code', d.alt);
  if (d.cls === 'aws-access-key' && Number($('uses').value) > 1) {
    line(box, 'span', 'Además, con varios usos la ventana de exposición crece. Para una AKIA conviene 1 solo uso.');
  }
  if (d.shortTtl && !ttlTouched) $('ttl').value = '3600';
}
$('secret').addEventListener('input', refresh);
$('uses').addEventListener('change', refresh);
$('notify').addEventListener('change', () => { $('notifyBox').hidden = !$('notify').checked; });

function fail(msg) { $('error').textContent = msg; $('error').hidden = false; }

$('go').addEventListener('click', async () => {
  $('error').hidden = true;
  const text = $('secret').value;
  if (!text.trim()) return fail('Escribe un secreto primero.');
  if (new TextEncoder().encode(text).length > 12000) return fail('El secreto es demasiado largo (máximo 12 000 bytes).');

  const d = detect(text);
  const body = { ttlSeconds: Number($('ttl').value), maxUses: Number($('uses').value) };
  if ($('notify').checked) {
    const email = $('email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Escribe un email válido para el recordatorio.');
    body.notify = { email, credClass: d?.cls ?? 'generic' };
    if (d?.keyId) body.notify.keyId = d.keyId;
  }

  $('go').disabled = true;
  try {
    const { ct, iv, key } = await encrypt(text);   // el texto plano nunca sale del navegador
    body.ct = ct; body.iv = iv;
    const r = await fetch('/api/secrets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return fail(`No se pudo crear (${data.error ?? r.status}).`);

    const link = `${location.origin}/reveal.html#${data.id}:${key}`;
    $('link').value = link;
    $('result').hidden = false;
    $('secret').value = '';
    refresh();
    const ttlLabel = $('ttl').selectedOptions[0].textContent.replace(' (demo)', '');
    const uses = data.maxUses === 1 ? '1 vez' : `${data.maxUses} veces`;
    $('resultHint').textContent = `Funciona ${uses} y expira en ${ttlLabel}.` +
      (body.notify ? ' Te avisaremos por email cuando se lea o expire.' : '');
    $('statusLink').href = `${location.origin}/status.html#${data.id}:${data.statusToken}`;
    $('copyLink').onclick = () => navigator.clipboard.writeText(link);
    $('copyMail').onclick = () => navigator.clipboard.writeText(
      `Hola,\n\nTe comparto una credencial de forma segura con Cirrus. El link funciona ${uses} y expira en ${ttlLabel}. ` +
      `Ábrelo y pulsa “Revelar secreto”:\n\n${link}\n\nSaludos`);
  } catch (e) {
    fail('Error inesperado. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    $('go').disabled = false;
  }
});
