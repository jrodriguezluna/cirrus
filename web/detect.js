// Devuelve null o { cls, title, msg, alt?, keyId?, shortTtl, level }
export function detect(input) {
  const t = (input ?? '').trim();
  if (!t) return null;

  const akia = t.match(/\bAKIA[0-9A-Z]{16}\b/);
  if (akia) return {
    cls: 'aws-access-key', keyId: akia[0], shortTtl: true, level: 'warn',
    title: 'Parece una access key de AWS de larga duración (AKIA…)',
    msg: 'Si se filtra, sigue válida hasta que alguien la desactive. Mejor comparte credenciales temporales:',
    alt: 'aws sts get-session-token --duration-seconds 3600',
  };
  if (/\bASIA[0-9A-Z]{16}\b/.test(t)) return {
    cls: 'aws-temp', shortTtl: true, level: 'info',
    title: 'Parece una credencial temporal de AWS (ASIA…)',
    msg: 'Buena práctica: expira sola. Aun así, un TTL corto reduce la exposición.',
  };
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return {
    cls: 'pem', shortTtl: true, level: 'warn',
    title: 'Parece una clave privada',
    msg: 'No se puede “revocar” un archivo copiado. Rota el par de claves cuando termines de usarla.',
  };
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/i.test(t)) return {
    cls: 'conn-string', shortTtl: true, level: 'warn',
    title: 'Parece una cadena de conexión con contraseña',
    msg: 'Rota la contraseña cuando se termine de usar. Si es de uso continuo, considera AWS Secrets Manager.',
  };
  const envLines = t.split('\n').filter((l) => /^[A-Z_][A-Z0-9_]*=.+/.test(l.trim()));
  if (envLines.length >= 2) return {
    cls: 'env', shortTtl: true, level: 'warn',
    title: 'Parece un archivo .env',
    msg: 'Puede contener varios secretos: rota cada uno cuando termines.',
  };
  return null;
}
