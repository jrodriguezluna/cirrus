import { flyPlane } from './ui.js';

const $ = (id) => document.getElementById(id);
const [id, ackToken] = location.hash.slice(1).split(':');

function say(text, cls) {
  const m = $('msg');
  m.textContent = text;
  m.className = cls;
  m.setAttribute('role', cls === 'err' ? 'alert' : 'status');
  m.hidden = false;
}

if (!id || !ackToken) {
  $('ack').hidden = true;
  $('ackHint').hidden = true;
  say('Este link está incompleto.', 'err');
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
      say('Listo, rotación confirmada. No enviaremos más recordatorios.', 'ok check-line');
      flyPlane('takeoffPlane', 'takeoff');
    } else {
      $('ack').disabled = false;
      say('No se pudo confirmar (link inválido o vencido).', 'err');
    }
  } catch {
    $('ack').disabled = false;
    say('Error de red. Inténtalo de nuevo.', 'err');
  }
});
