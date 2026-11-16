import { encrypt } from './crypto.js';
import { detect } from './detect.js';
import { segmented } from './segmented.js';
import { copyText, flyPlane, reducedMotion } from './ui.js';

const $ = (id) => document.getElementById(id);
let ttlTouched = false;
$('ttl').addEventListener('change', () => { ttlTouched = true; });
// Controles segmentados sobre los <select>; syncTtl refleja cambios hechos por código
const syncTtl = segmented($('ttl'), 'Expira en');
segmented($('uses'), 'Usos permitidos');

// Rotación: se marca sola si el tipo detectado es rotable; si no, es decisión manual del emisor.
// El seguimiento (avisos por email) y la rotación (checklist, recordatorios, confirmación) son opciones distintas.
let rotateTouched = false;
$('rotate').addEventListener('change', () => { rotateTouched = true; });

function syncRotate(d) {
  const sinRotacion = 'Sin esto, recibes solo un aviso al leerse o expirar.';
  if (d?.rotable) {
    $('rotateLabel').textContent = 'Recordarme rotar esta credencial';
    $('rotateHint').textContent = `Detectamos ${d.kind}. Te enviamos el checklist de rotación para ese tipo, hasta 3 recordatorios y un link para confirmar. ${sinRotacion}`;
  } else if (d) {
    $('rotateLabel').textContent = 'Recordarme rotar esta credencial';
    $('rotateHint').textContent = `Detectamos ${d.kind}: expira sola, así que normalmente no hace falta rotarla. Márcalo solo si quieres el recordatorio.`;
  } else {
    $('rotateLabel').textContent = 'Es una credencial que debo rotar';
    $('rotateHint').textContent = `No reconocimos el tipo de credencial. Si lo marcas, recibes un checklist genérico, hasta 3 recordatorios y un link para confirmar. ${sinRotacion}`;
  }
  if (!rotateTouched) $('rotate').checked = Boolean(d?.rotable);
}
syncRotate(null);

function line(parent, tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function refresh() {
  const d = detect($('secret').value);
  syncRotate(d);
  const box = $('detect');
  box.replaceChildren();
  if (!d) {
    box.hidden = true;
    if (!ttlTouched) { $('ttl').value = '86400'; syncTtl(); }
    return;
  }
  box.hidden = false;
  box.className = `box ${d.level}`;
  line(box, 'strong', d.title);
  line(box, 'span', d.msg);
  if (d.alt) line(box, 'code', d.alt);
  if (d.level === 'warn' && Number($('uses').value) > 1) {
    line(box, 'span', 'Además, con varios usos la ventana de exposición crece. Para esta credencial conviene 1 solo uso.');
  }
  if (d.shortTtl && !ttlTouched) { $('ttl').value = '3600'; syncTtl(); }
}
$('secret').addEventListener('input', refresh);
$('uses').addEventListener('change', refresh);
$('notify').addEventListener('change', () => { $('notifyBox').hidden = !$('notify').checked; });
$('link').addEventListener('focus', (e) => e.target.select());

function fail(msg) { $('error').textContent = msg; $('error').hidden = false; }

$('go').addEventListener('click', async () => {
  $('error').hidden = true;
  const text = $('secret').value;
  if (!text.trim()) return fail('Escribe un secreto primero.');
  if (new TextEncoder().encode(text).length > 12000) return fail('El secreto es demasiado largo (máximo 12 000 bytes).');

  const pass = $('pass').value;
  const adv = document.querySelector('.adv');
  if (pass && pass.length < 12) { adv.open = true; $('pass').focus(); return fail('La passphrase debe tener al menos 12 caracteres.'); }
  const caseRef = $('caseRef').value.trim();
  if (caseRef && /[\u0000-\u001F\u007F<>]/.test(caseRef)) { adv.open = true; $('caseRef').focus(); return fail('La referencia tiene caracteres no permitidos.'); }

  const d = detect(text);
  const body = { ttlSeconds: Number($('ttl').value), maxUses: Number($('uses').value) };
  if (caseRef) body.caseRef = caseRef;
  if (pass) body.pass = true;
  if ($('notify').checked) {
    const email = $('email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Escribe un email válido para los avisos.');
    const rotate = $('rotate').checked;
    body.notify = { email, credClass: d?.cls ?? 'generic', rotate };
    // El tipo y la ID de la key solo sirven para el checklist de rotación: sin rotación no se envían
    if (rotate && d?.keyId) body.notify.keyId = d.keyId;
    if (rotate && d?.account) body.notify.account = d.account;
  }

  $('go').disabled = true;
  $('go').classList.add('loading');
  $('go').textContent = 'Cifrando…';
  try {
    const { ct, iv, key } = await encrypt(text, pass || undefined);   // nada en claro sale del navegador
    body.ct = ct; body.iv = iv;
    const r = await fetch('/api/secrets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return fail(`No se pudo crear (${data.error ?? r.status}).`);

    const link = `${location.origin}/reveal.html#${data.id}:${key}`;
    $('link').value = link;
    $('result').hidden = true;          // ocultar y mostrar de nuevo reinicia la animación de entrada
    void $('result').offsetWidth;
    $('result').hidden = false;
    $('secret').value = '';
    $('pass').value = '';
    rotateTouched = false;
    refresh();
    const ttlLabel = $('ttl').selectedOptions[0].textContent.replace(' (demo)', '');
    const uses = data.maxUses === 1 ? '1 vez' : `${data.maxUses} veces`;

    // Resumen visual del link: hechos en chips, indicaciones en el texto de ayuda
    const chips = $('resultChips');
    chips.replaceChildren();
    for (const t of [
      `Funciona ${uses}`, `Expira en ${ttlLabel}`, pass && 'Con passphrase',
      body.notify && 'Seguimiento por email', body.notify?.rotate && 'Con recordatorio de rotación',
    ]) {
      if (t) line(chips, 'li', t);
    }
    const notes = [];
    if (pass) notes.push('Recuerda enviar la passphrase por otro canal.');
    if (!body.notify) notes.push('Sin seguimiento por email: Cirrus no te avisará cuando se lea. Puedes consultar el estado en el link de abajo.');
    else if (body.notify.rotate) notes.push('Recibirás un aviso cuando se lea o expire, con el checklist de rotación y recordatorios hasta que confirmes.');
    else notes.push('Recibirás un aviso por email cuando se lea o expire.');
    $('resultHint').textContent = notes.join(' ');

    $('statusLink').href = `${location.origin}/status.html#${data.id}:${data.statusToken}`;
    $('copyLink').onclick = () => copyText($('copyLink'), link, { onFail: () => $('link').select() });
    $('copyMail').onclick = () => {
      const parts = ['Hola,', '', `Te comparto una credencial de forma segura con Cirrus. El link funciona ${uses} y expira en ${ttlLabel}.`];
      if (caseRef) parts.push(`Referencia: ${caseRef}`);
      parts.push('Ábrelo y pulsa “Revelar secreto”:', '', link, '');
      if (pass) parts.push('La passphrase te la envío por otro canal.', '');
      parts.push('Saludos');
      copyText($('copyMail'), parts.join('\n'));
    };
    flyPlane();
    $('result').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  } catch (e) {
    fail('Error inesperado. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    $('go').disabled = false;
    $('go').classList.remove('loading');
    $('go').textContent = 'Crear link';
  }
});
