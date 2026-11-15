const enc = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const dec = (s) => {
  const p = s.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};
const ITER = 600000;

async function passKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { ct: new Uint8Array(ct), iv };
}

// Capa interior (opcional): passphrase. Capa exterior: clave aleatoria que viaja en el # del link.
export async function encrypt(plaintext, passphrase) {
  let bytes = new TextEncoder().encode(plaintext);
  if (passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const inner = await seal(await passKey(passphrase, salt), bytes);
    bytes = new TextEncoder().encode(JSON.stringify({ v: 2, s: enc(salt), i: enc(inner.iv), c: enc(inner.ct) }));
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const outer = await seal(key, bytes);
  const raw = await crypto.subtle.exportKey('raw', key);
  return { ct: enc(outer.ct), iv: enc(outer.iv), key: enc(raw) };
}

export async function openOuter({ ct, iv, key }) {
  const k = await crypto.subtle.importKey('raw', dec(key), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(iv) }, k, dec(ct));
  return new TextDecoder().decode(pt);
}

export async function openInner(json, passphrase) {
  const { s, i, c } = JSON.parse(json);
  const k = await passKey(passphrase, dec(s));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(i) }, k, dec(c));
  return new TextDecoder().decode(pt);
}
