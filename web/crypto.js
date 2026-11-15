const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const dec = (s) => {
  const p = s.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};

export async function encrypt(plaintext) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const raw = await crypto.subtle.exportKey('raw', key);
  return { ct: enc(ct), iv: enc(iv), key: enc(raw) };
}

export async function decrypt({ ct, iv, key }) {
  const k = await crypto.subtle.importKey('raw', dec(key), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(iv) }, k, dec(ct));
  return new TextDecoder().decode(pt);
}
