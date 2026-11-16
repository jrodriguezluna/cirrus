import { bind } from './i18n.js';   // primero: traduce la página antes de que corra el resto
import { flyPlane } from './ui.js';

const $ = (id) => document.getElementById(id);
const [id, ackToken] = location.hash.slice(1).split(':');

// El mensaje queda enlazado a su clave: si cambia el idioma, se traduce solo
function say(key, cls) {
  const m = $('msg');
  bind(m, key);
  m.className = cls;
  m.setAttribute('role', cls === 'err' ? 'alert' : 'status');
  m.hidden = false;
}

if (!id || !ackToken) {
  $('ack').hidden = true;
  $('ackHint').hidden = true;
  say('link.incomplete', 'err');
}

$('ack').addEventListener('click', async () => {
  $('ack').disabled = true;
  try {
    const r = await fetch('/api/ack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ackToken }),
    });
    if (r.ok) {
      $('ack').hidden = true;
      $('ackHint').hidden = true;
      say('ack.done', 'ok check-line');
      flyPlane('takeoffPlane', 'takeoff');
    } else {
      $('ack').disabled = false;
      say('ack.fail', 'err');
    }
  } catch {
    $('ack').disabled = false;
    say('ack.net', 'err');
  }
});
