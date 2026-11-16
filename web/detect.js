// Textos de cada tipo detectado, por idioma. `alt` es un comando: no se traduce.
const TEXTS = {
  'gcp-sa': {
    es: { kind: 'service account de GCP', title: 'Parece la clave JSON de una service account de GCP', msg: 'Estas claves no expiran solas. Si puedes, usa impersonación de service account:' },
    en: { kind: 'GCP service account', title: 'Looks like a GCP service account JSON key', msg: 'These keys do not expire on their own. If you can, use service account impersonation:' },
    alt: 'gcloud auth print-access-token --impersonate-service-account=SA_EMAIL',
  },
  'aws-access-key': {
    es: { kind: 'access key de AWS', title: 'Parece una access key de AWS de larga duración (AKIA…)', msg: 'Si se filtra, sigue válida hasta que alguien la desactive. Mejor comparte credenciales temporales:' },
    en: { kind: 'AWS access key', title: 'Looks like a long-lived AWS access key (AKIA…)', msg: 'If it leaks, it stays valid until someone deactivates it. Share temporary credentials instead:' },
    alt: 'aws sts get-session-token --duration-seconds 3600',
  },
  'aws-temp': {
    es: { kind: 'credencial temporal de AWS', title: 'Parece una credencial temporal de AWS (ASIA…)', msg: 'Buena práctica: expira sola. Aun así, un TTL corto reduce la exposición.' },
    en: { kind: 'temporary AWS credential', title: 'Looks like a temporary AWS credential (ASIA…)', msg: 'Good practice: it expires on its own. A short TTL still reduces exposure.' },
  },
  'github-token': {
    es: { kind: 'token de GitHub', title: 'Parece un token de GitHub', msg: 'Los tokens clásicos no expiran por defecto. Prefiere tokens de grano fino con expiración corta.' },
    en: { kind: 'GitHub token', title: 'Looks like a GitHub token', msg: 'Classic tokens do not expire by default. Prefer fine-grained tokens with a short expiry.' },
  },
  'slack-token': {
    es: { kind: 'token de Slack', title: 'Parece un token de Slack', msg: 'Puede dar acceso amplio al workspace. Compártelo solo si es imprescindible y revócalo después.' },
    en: { kind: 'Slack token', title: 'Looks like a Slack token', msg: 'It can grant broad access to the workspace. Share it only if essential and revoke it afterwards.' },
  },
  'azure-secret': {
    es: { kind: 'client secret de Azure', title: 'Parece un client secret de Azure', msg: 'Vive hasta su fecha de vencimiento. Considera identidades administradas o federación de workload.' },
    en: { kind: 'Azure client secret', title: 'Looks like an Azure client secret', msg: 'It lives until its expiry date. Consider managed identities or workload federation.' },
  },
  pem: {
    es: { kind: 'clave privada', title: 'Parece una clave privada', msg: 'No se puede “revocar” un archivo copiado. Rota el par de claves cuando termines de usarla.' },
    en: { kind: 'private key', title: 'Looks like a private key', msg: 'A copied file cannot be “revoked”. Rotate the key pair when you are done with it.' },
  },
  'conn-string': {
    es: { kind: 'cadena de conexión', title: 'Parece una cadena de conexión con contraseña', msg: 'Rota la contraseña cuando se termine de usar. Si es de uso continuo, considera AWS Secrets Manager.' },
    en: { kind: 'connection string', title: 'Looks like a connection string with a password', msg: 'Rotate the password when you are done. If it is for continuous use, consider AWS Secrets Manager.' },
  },
  env: {
    es: { kind: 'archivo .env', title: 'Parece un archivo .env', msg: 'Puede contener varios secretos: rota cada uno cuando termines.' },
    en: { kind: '.env file', title: 'Looks like a .env file', msg: 'It may contain several secrets: rotate each one when you are done.' },
  },
};

// Textos de un tipo en un idioma: { kind, title, msg, alt? }. Idioma desconocido: español.
export function describe(cls, lang = 'es') {
  const e = TEXTS[cls];
  if (!e) return null;
  const x = e[lang] ?? e.es;
  return e.alt ? { ...x, alt: e.alt } : x;
}

// Devuelve null o { cls, kind, rotable, title, msg, alt?, keyId?, account?, shortTtl, level }
//   kind    nombre corto del tipo detectado ("access key de AWS"), para mostrarlo en la interfaz
//   rotable false si la credencial expira sola y normalmente no hace falta rotarla
// `lang` ('es' | 'en') elige el idioma de kind, title y msg. Todo corre en el navegador.
export function detect(input, lang = 'es') {
  const t = (input ?? '').trim();
  if (!t) return null;
  const found = (cls, extra) => ({ cls, ...describe(cls, lang), shortTtl: true, ...extra });

  // JSON de service account (antes que PEM: contiene una clave privada)
  if (/"type"\s*:\s*"service_account"/.test(t)) return found('gcp-sa', {
    rotable: true, level: 'warn',
    keyId: t.match(/"private_key_id"\s*:\s*"([0-9a-f]{40})"/)?.[1],
    account: t.match(/"client_email"\s*:\s*"([^"\s]+@[^"\s]+)"/)?.[1],
  });

  const akia = t.match(/\bAKIA[0-9A-Z]{16}\b/);
  if (akia) return found('aws-access-key', { rotable: true, keyId: akia[0], level: 'warn' });
  if (/\bASIA[0-9A-Z]{16}\b/.test(t)) return found('aws-temp', { rotable: false, level: 'info' });
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/.test(t)) return found('github-token', { rotable: true, level: 'warn' });
  if (/\bxox[abprs]-[A-Za-z0-9-]{10,}/.test(t)) return found('slack-token', { rotable: true, level: 'warn' });
  if (/[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}/.test(t)) return found('azure-secret', { rotable: true, level: 'warn' });
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return found('pem', { rotable: true, level: 'warn' });
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/i.test(t)) return found('conn-string', { rotable: true, level: 'warn' });
  const envLines = t.split('\n').filter((l) => /^[A-Z_][A-Z0-9_]*=.+/.test(l.trim()));
  if (envLines.length >= 2) return found('env', { rotable: true, level: 'warn' });
  return null;
}
