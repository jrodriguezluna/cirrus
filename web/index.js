import { t, bind, getLang, onLangChange } from './i18n.js';   // primero: traduce la página antes de que corra el resto
import { encrypt } from './crypto.js';
import { detect } from './detect.js';
import { segmented } from './segmented.js';
import { copyText, flyPlane, reducedMotion } from './ui.js';

const $ = (id) => document.getElementById(id);
let ttlTouched = false;
$('ttl').addEventListener('change', () => { ttlTouched = true; });
// Controles segmentados sobre los <select>; syncTtl refleja cambios hechos por código
const syncTtl = segmented($('ttl'), () => t('index.ttl.label'));
const syncUses = segmented($('uses'), () => t('index.uses.label'));
bind($('go'), 'index.go');

// Rotación: se marca sola si el tipo detectado es rotable; si no, es decisión manual del emisor.
// El seguimiento (avisos por email) y la rotación (checklist, recordatorios, confirmación) son opciones distintas.
let rotateTouched = false;
$('rotate').addEventListener('change', () => { rotateTouched = true; });

function syncRotate(d) {
  if (d?.rotable) {
    $('rotateLabel').textContent = t('rotate.label.rotable');
    $('rotateHint').textContent = t('rotate.hint.rotable', { kind: d.kind, note: t('rotate.note') });
  } else if (d) {
    $('rotateLabel').textContent = t('rotate.label.rotable');
    $('rotateHint').textContent = t('rotate.hint.temp', { kind: d.kind });
  } else {
    $('rotateLabel').textContent = t('rotate.label.unknown');
    $('rotateHint').textContent = t('rotate.hint.unknown', { note: t('rotate.note') });
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
  const d = detect($('secret').value, getLang());
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
    line(box, 'span', t('detect.multiUse'));
  }
  if (d.shortTtl && !ttlTouched) { $('ttl').value = '3600'; syncTtl(); }
}
$('secret').addEventListener('input', refresh);
$('uses').addEventListener('change', refresh);
$('notify').addEventListener('change', () => { $('notifyBox').hidden = !$('notify').checked; });
$('link').addEventListener('focus', (e) => e.target.select());

// El error queda enlazado a su clave: si cambia el idioma, se traduce solo
function fail(key, params) { bind($('error'), key, params); $('error').hidden = false; }

// Resumen del link creado. Se vuelve a pintar si cambia el idioma.
let lastResult = null;
function renderResult() {
  const r = lastResult;
  if (!r) return;
  // Resumen visual del link: hechos en chips, indicaciones en el texto de ayuda
  const chips = $('resultChips');
  chips.replaceChildren();
  for (const c of [
    ['chip.works', { uses: () => t('uses.times', { n: r.uses }) }],
    ['chip.expires', { ttl: () => t(`ttl.name.${r.ttl}`) }],
    r.pass && ['chip.pass'],
    r.notify && ['chip.follow'],
    r.rotate && ['chip.rotate'],
  ]) {
    if (!c) continue;
    const li = document.createElement('li');
    bind(li, c[0], c[1]);
    chips.appendChild(li);
  }
  const notes = [];
  if (r.pass) notes.push('note.pass');
  if (!r.notify) notes.push('note.noFollow');
  else notes.push(r.rotate ? 'note.rotate' : 'note.follow');
  $('resultHint').textContent = notes.map((k) => t(k)).join(' ');
}

onLangChange(() => {
  syncTtl();
  syncUses();
  refresh();
  renderResult();
  // El botón principal mantiene su estado (ocupado o no)
  bind($('go'), $('go').classList.contains('loading') ? 'index.go.busy' : 'index.go');
});

$('go').addEventListener('click', async () => {
  $('error').hidden = true;
  const text = $('secret').value;
  if (!text.trim()) return fail('err.empty');
  if (new TextEncoder().encode(text).length > 12000) return fail('err.tooLong');

  const pass = $('pass').value;
  const adv = document.querySelector('.adv');
  if (pass && pass.length < 12) { adv.open = true; $('pass').focus(); return fail('err.passShort'); }
  const caseRef = $('caseRef').value.trim();
  if (caseRef && /[\u0000-\u001F\u007F<>]/.test(caseRef)) { adv.open = true; $('caseRef').focus(); return fail('err.refChars'); }

  const d = detect(text, getLang());
  const body = { ttlSeconds: Number($('ttl').value), maxUses: Number($('uses').value) };
  if (caseRef) body.caseRef = caseRef;
  if (pass) body.pass = true;
  if ($('notify').checked) {
    const email = $('email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('err.email');
    const rotate = $('rotate').checked;
    body.notify = { email, credClass: d?.cls ?? 'generic', rotate, lang: getLang() };   // idioma de los correos
    // El tipo y la ID de la key solo sirven para el checklist de rotación: sin rotación no se envían
    if (rotate && d?.keyId) body.notify.keyId = d.keyId;
    if (rotate && d?.account) body.notify.account = d.account;
  }

  $('go').disabled = true;
  $('go').classList.add('loading');
  bind($('go'), 'index.go.busy');
  try {
    const { ct, iv, key } = await encrypt(text, pass || undefined);   // nada en claro sale del navegador
    body.ct = ct; body.iv = iv;
    const r = await fetch('/api/secrets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return fail('err.create', { code: data.error ?? r.status });

    const link = `${location.origin}/reveal.html#${data.id}:${key}`;
    $('link').value = link;
    $('result').hidden = true;          // ocultar y mostrar de nuevo reinicia la animación de entrada
    void $('result').offsetWidth;
    $('result').hidden = false;
    $('secret').value = '';
    $('pass').value = '';
    rotateTouched = false;
    refresh();
    lastResult = { uses: data.maxUses, ttl: body.ttlSeconds, pass: Boolean(pass), caseRef, notify: Boolean(body.notify), rotate: Boolean(body.notify?.rotate), link };
    renderResult();
    $('statusLink').href = `${location.origin}/status.html#${data.id}:${data.statusToken}`;
    $('copyLink').onclick = () => copyText($('copyLink'), link, { onFail: () => $('link').select() });
    $('copyMail').onclick = () => {
      const r = lastResult;
      const parts = [t('mail.hello'), '', t('mail.share', { uses: t('uses.times', { n: r.uses }), ttl: t(`ttl.name.${r.ttl}`) })];
      if (r.caseRef) parts.push(t('mail.ref', { ref: r.caseRef }));
      parts.push(t('mail.open', { button: t('reveal.btn') }), '', r.link, '');
      if (r.pass) parts.push(t('mail.pass'), '');
      parts.push(t('mail.bye'));
      copyText($('copyMail'), parts.join('\n'));
    };
    flyPlane();
    $('result').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  } catch (e) {
    fail('err.unexpectedNet');
  } finally {
    $('go').disabled = false;
    $('go').classList.remove('loading');
    bind($('go'), 'index.go');
  }
});
