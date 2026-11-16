// Devuelve null o { cls, kind, rotable, title, msg, alt?, keyId?, account?, shortTtl, level }
//   kind    nombre corto del tipo detectado ("access key de AWS"), para mostrarlo en la interfaz
//   rotable false si la credencial expira sola y normalmente no hace falta rotarla
export function detect(input) {
  const t = (input ?? '').trim();
  if (!t) return null;

  // JSON de service account (antes que PEM: contiene una clave privada)
  if (/"type"\s*:\s*"service_account"/.test(t)) return {
    cls: 'gcp-sa', kind: 'service account de GCP', rotable: true, shortTtl: true, level: 'warn',
    keyId: t.match(/"private_key_id"\s*:\s*"([0-9a-f]{40})"/)?.[1],
    account: t.match(/"client_email"\s*:\s*"([^"\s]+@[^"\s]+)"/)?.[1],
    title: 'Parece la clave JSON de una service account de GCP',
    msg: 'Estas claves no expiran solas. Si puedes, usa impersonación de service account:',
    alt: 'gcloud auth print-access-token --impersonate-service-account=SA_EMAIL',
  };

  const akia = t.match(/\bAKIA[0-9A-Z]{16}\b/);
  if (akia) return {
    cls: 'aws-access-key', kind: 'access key de AWS', rotable: true, keyId: akia[0], shortTtl: true, level: 'warn',
    title: 'Parece una access key de AWS de larga duración (AKIA…)',
    msg: 'Si se filtra, sigue válida hasta que alguien la desactive. Mejor comparte credenciales temporales:',
    alt: 'aws sts get-session-token --duration-seconds 3600',
  };
  if (/\bASIA[0-9A-Z]{16}\b/.test(t)) return {
    cls: 'aws-temp', kind: 'credencial temporal de AWS', rotable: false, shortTtl: true, level: 'info',
    title: 'Parece una credencial temporal de AWS (ASIA…)',
    msg: 'Buena práctica: expira sola. Aun así, un TTL corto reduce la exposición.',
  };
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/.test(t)) return {
    cls: 'github-token', kind: 'token de GitHub', rotable: true, shortTtl: true, level: 'warn',
    title: 'Parece un token de GitHub',
    msg: 'Los tokens clásicos no expiran por defecto. Prefiere tokens de grano fino con expiración corta.',
  };
  if (/\bxox[abprs]-[A-Za-z0-9-]{10,}/.test(t)) return {
    cls: 'slack-token', kind: 'token de Slack', rotable: true, shortTtl: true, level: 'warn',
    title: 'Parece un token de Slack',
    msg: 'Puede dar acceso amplio al workspace. Compártelo solo si es imprescindible y revócalo después.',
  };
  if (/[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}/.test(t)) return {
    cls: 'azure-secret', kind: 'client secret de Azure', rotable: true, shortTtl: true, level: 'warn',
    title: 'Parece un client secret de Azure',
    msg: 'Vive hasta su fecha de vencimiento. Considera identidades administradas o federación de workload.',
  };
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return {
    cls: 'pem', kind: 'clave privada', rotable: true, shortTtl: true, level: 'warn',
    title: 'Parece una clave privada',
    msg: 'No se puede “revocar” un archivo copiado. Rota el par de claves cuando termines de usarla.',
  };
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/i.test(t)) return {
    cls: 'conn-string', kind: 'cadena de conexión', rotable: true, shortTtl: true, level: 'warn',
    title: 'Parece una cadena de conexión con contraseña',
    msg: 'Rota la contraseña cuando se termine de usar. Si es de uso continuo, considera AWS Secrets Manager.',
  };
  const envLines = t.split('\n').filter((l) => /^[A-Z_][A-Z0-9_]*=.+/.test(l.trim()));
  if (envLines.length >= 2) return {
    cls: 'env', kind: 'archivo .env', rotable: true, shortTtl: true, level: 'warn',
    title: 'Parece un archivo .env',
    msg: 'Puede contener varios secretos: rota cada uno cuando termines.',
  };
  return null;
}
