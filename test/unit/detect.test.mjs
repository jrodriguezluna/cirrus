// Detección del tipo de credencial (web/detect.js). Todos los ejemplos son ficticios:
// tienen el formato real de cada servicio, pero valores inventados o de la documentación oficial.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../../web/detect.js';

const hex40 = 'a'.repeat(40);
const fill = (n, chars = 'aB3dE5gH7j') => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
const AKIA = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const gcpJson = JSON.stringify({
  type: 'service_account', project_id: 'demo', private_key_id: hex40,
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
  client_email: 'robot@demo.iam.gserviceaccount.com',
}, null, 2);

describe('detect: tipos que debe reconocer', () => {
  const casos = [
    ['AWS access key (solo la ID)', AKIA, 'aws-access-key'],
    ['AWS credentials (ID + secret)', `[default]\naws_access_key_id = ${AKIA}\naws_secret_access_key = ${AWS_SECRET}`, 'aws-access-key'],
    ['AWS temporal (ASIA…)', 'export AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE\nexport AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE', 'aws-temp'],
    ['GitHub clásico (ghp_)', `ghp_${fill(36)}`, 'github-token'],
    ['GitHub OAuth (gho_)', `gho_${fill(36)}`, 'github-token'],
    ['GitHub de servidor (ghs_)', `ghs_${fill(36)}`, 'github-token'],
    ['GitHub fine-grained (github_pat_)', `github_pat_11ABCDEFG0${fill(12)}_${fill(59)}`, 'github-token'],
    ['Slack bot (xoxb-)', `xoxb-123456789012-1234567890123-${fill(24)}`, 'slack-token'],
    ['Slack user (xoxp-)', `xoxp-123456789012-123456789012-123456789012-${fill(32)}`, 'slack-token'],
    ['Azure client secret', `Zxy8Q~${fill(34, 'aB3dE5gH7j.-_')}`, 'azure-secret'],
    ['GCP service account (JSON)', gcpJson, 'gcp-sa'],
    ['Clave privada RSA', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----', 'pem'],
    ['Clave privada OpenSSH', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...\n-----END OPENSSH PRIVATE KEY-----', 'pem'],
    ['Conexión postgres', 'postgres://admin:S3cr3tPass@db.example.com:5432/app', 'conn-string'],
    ['Conexión mongodb+srv', 'mongodb+srv://user:pa55w0rd@cluster0.abcde.mongodb.net/test', 'conn-string'],
    ['Archivo .env', 'DB_HOST=localhost\nDB_PASSWORD=hunter2\nAPI_URL=https://x.io', 'env'],
    ['.env que contiene una AKIA (AWS tiene prioridad)', `AWS_ACCESS_KEY_ID=${AKIA}\nAWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, 'aws-access-key'],
  ];
  for (const [nombre, texto, clase] of casos) {
    it(nombre, () => assert.equal(detect(texto)?.cls, clase));
  }
});

describe('detect: texto normal no debe marcarse (sin falsos positivos)', () => {
  const casos = [
    ['contraseña normal', 'correct-horse-battery-staple'],
    ['frase cualquiera', 'hola, esta es la clave del wifi: gato1234'],
    ['prosa que menciona prefijos', 'Los tokens de GitHub empiezan con ghp_ y los de Slack con xoxb-'],
    ['una sola línea KEY=valor (no es un .env)', 'TOKEN=abc123'],
    ['UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['hash de 40 hex (no es una service account)', hex40],
    ['URL sin credenciales', 'https://example.com/path?x=1'],
    ['vacío', ''],
    ['solo espacios', '   \n  '],
  ];
  for (const [nombre, texto] of casos) {
    it(nombre, () => assert.equal(detect(texto), null));
  }
});

describe('detect: datos extraídos', () => {
  it('AWS: extrae la ID de la key', () => assert.equal(detect(AKIA).keyId, AKIA));
  it('GCP: extrae private_key_id y client_email', () => {
    const d = detect(gcpJson);
    assert.equal(d.keyId, hex40);
    assert.equal(d.account, 'robot@demo.iam.gserviceaccount.com');
  });
  it('los datos extraídos cumplen las mismas reglas que valida el servidor', () => {
    assert.match(detect(AKIA).keyId, /^AKIA[0-9A-Z]{16}$/);
    assert.match(detect(gcpJson).keyId, /^[0-9a-f]{40}$/);
  });
});

describe('detect: qué se ofrece rotar', () => {
  it('toda credencial reconocida es rotable, salvo la temporal de AWS', () => {
    const rotables = [AKIA, `ghp_${fill(36)}`, `xoxb-123456789012-1234567890123-${fill(24)}`, `Zxy8Q~${fill(34, 'aB3dE5gH7j.-_')}`, gcpJson,
      '-----BEGIN RSA PRIVATE KEY-----\nx', 'postgres://a:b@h/db', 'A=1\nB=2'];
    for (const t of rotables) assert.equal(detect(t).rotable, true, t.slice(0, 30));
    assert.equal(detect('ASIAIOSFODNN7EXAMPLE').rotable, false);
  });
  it('cada tipo trae un nombre legible para la interfaz', () => {
    assert.equal(detect(AKIA).kind, 'access key de AWS');
    assert.equal(detect(`ghp_${fill(36)}`).kind, 'token de GitHub');
    assert.equal(detect('A=1\nB=2').kind, 'archivo .env');
  });
  it('los tipos con credencial de larga duración recomiendan un TTL corto', () => {
    for (const t of [AKIA, `ghp_${fill(36)}`, 'A=1\nB=2']) assert.equal(detect(t).shortTtl, true);
  });
});

// Documenta el comportamiento ACTUAL: estas credenciales reales no se reconocen y caen en la
// casilla manual "Es una credencial que debo rotar". Si algún día se añade su detección,
// este test fallará a propósito: actualízalo y añade su checklist en src/lifecycle (steps) y su
// clase en CLASSES de src/create.
describe('detect: tipos reales aún no reconocidos (quedan como genéricos)', () => {
  const casos = [
    ['AWS secret key sola (40 caracteres)', AWS_SECRET],
    ['OpenAI / Anthropic (sk-…)', `sk-proj-${fill(48)}`],
    ['Stripe live (sk_live_…)', `sk_live_${fill(24)}`],
    ['Google API key (AIza…)', `AIza${fill(35)}`],
    ['GitLab (glpat-…)', `glpat-${fill(20)}`],
    ['npm (npm_…)', `npm_${fill(36)}`],
    ['JWT', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ];
  for (const [nombre, texto] of casos) {
    it(nombre, () => assert.equal(detect(texto), null));
  }
});
