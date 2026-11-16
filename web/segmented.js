// Control segmentado accesible construido sobre un <select>.
// El <select> sigue siendo la fuente de verdad (oculto): el resto del código lee select.value.
// Devuelve sync(): llamarla tras cambiar select.value por código para reflejarlo en la UI.
export function segmented(select, label) {
  const group = document.createElement('div');
  group.className = 'seg';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);

  const options = [...select.options];
  const buttons = options.map((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-opt';
    b.setAttribute('role', 'radio');
    b.dataset.value = opt.value;
    b.textContent = opt.dataset.short ?? opt.textContent;
    return b;
  });
  group.append(...buttons);

  function sync() {
    for (const b of buttons) {
      const on = b.dataset.value === select.value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('on', on);
    }
  }

  function choose(i) {
    const b = buttons[(i + buttons.length) % buttons.length];
    select.value = b.dataset.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
    b.focus();
  }

  group.addEventListener('click', (e) => {
    const i = buttons.indexOf(e.target.closest('.seg-opt'));
    if (i >= 0) choose(i);
  });
  group.addEventListener('keydown', (e) => {
    const i = buttons.findIndex((b) => b.tabIndex === 0);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); choose(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); choose(i - 1); }
  });

  select.hidden = true;
  select.after(group);
  sync();
  return sync;
}
