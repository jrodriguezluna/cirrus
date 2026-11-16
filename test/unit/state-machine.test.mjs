// Definición de la state machine (statemachine/lifecycle.asl.json): integridad, reintentos,
// coherencia con las acciones de lifecycle y enrutado de los Choice según `rotate`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const asl = JSON.parse(readFileSync(new URL('../../statemachine/lifecycle.asl.json', import.meta.url), 'utf8'));
const S = asl.States;
const lifecycleSrc = readFileSync(new URL('../../src/lifecycle/index.mjs', import.meta.url), 'utf8');

const siguientes = (s) => [s.Next, s.Default, ...(s.Choices ?? []).map((c) => c.Next), ...(s.Catch ?? []).map((c) => c.Next)].filter(Boolean);

describe('state machine: integridad', () => {
  it('StartAt existe y todos los destinos (Next, Default, Choices, Catch) existen', () => {
    assert.ok(S[asl.StartAt]);
    for (const [nombre, s] of Object.entries(S)) {
      for (const t of siguientes(s)) assert.ok(S[t], `${nombre} apunta a un estado inexistente: ${t}`);
    }
  });

  it('todos los estados son alcanzables desde StartAt', () => {
    const vistos = new Set(); const pila = [asl.StartAt];
    while (pila.length) { const n = pila.pop(); if (vistos.has(n)) continue; vistos.add(n); pila.push(...siguientes(S[n])); }
    assert.deepEqual(Object.keys(S).filter((n) => !vistos.has(n)), []);
  });

  it('el estado final es Succeed y no tiene transición', () => {
    assert.equal(S.Closed.Type, 'Succeed');
    assert.equal(S.Closed.Next, undefined);
  });
});

describe('state machine: reintentos ante errores transitorios', () => {
  const tareas = Object.entries(S).filter(([, s]) => s.Type === 'Task');

  it('hay tareas', () => assert.ok(tareas.length >= 6));

  for (const [nombre, s] of tareas) {
    it(`${nombre}: reintenta errores de Lambda con backoff`, () => {
      assert.ok(s.Retry?.length, 'falta Retry');
      const r = s.Retry[0];
      for (const e of ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException']) {
        assert.ok(r.ErrorEquals.includes(e), `no reintenta ${e}`);
      }
      assert.ok(r.MaxAttempts >= 2 && r.BackoffRate > 1);
    });
  }

  it('WaitForRead sigue pasando a NotifyExpired cuando vence el TTL', () => {
    assert.ok(S.WaitForRead.Catch.some((c) => c.ErrorEquals.includes('States.Timeout') && c.Next === 'NotifyExpired'));
  });
});

describe('state machine: coherencia con lifecycle', () => {
  it('toda acción que invoca la state machine existe en el handler de lifecycle', () => {
    const declaradas = lifecycleSrc.match(/const actions = \{([^}]*)\}/)[1].split(',').map((x) => x.trim()).filter(Boolean);
    const usadas = Object.values(S).filter((s) => s.Parameters?.Payload?.action).map((s) => s.Parameters.Payload.action);
    assert.ok(usadas.length >= 6);
    for (const a of usadas) assert.ok(declaradas.includes(a), `la acción "${a}" no existe en lifecycle`);
  });
});

// Evalúa un Choice como lo hace Step Functions: reglas en orden; una comparación sobre una variable
// que no existe es un error (States.Runtime), salvo IsPresent. Por eso las reglas del ASL van separadas.
function enrutar(estado, ctx) {
  for (const c of S[estado].Choices) {
    let cur = ctx, presente = true;
    for (const p of c.Variable.slice(2).split('.')) { if (cur && typeof cur === 'object' && p in cur) cur = cur[p]; else { presente = false; break; } }
    if ('IsPresent' in c) { if (presente === c.IsPresent) return c.Next; continue; }
    if (!presente) throw new Error(`States.Runtime: ${c.Variable} no existe`);
    if ('BooleanEquals' in c && cur === c.BooleanEquals) return c.Next;
    if ('NumericLessThanEquals' in c && cur <= c.NumericLessThanEquals) return c.Next;
    if ('NumericGreaterThanEquals' in c && cur >= c.NumericGreaterThanEquals) return c.Next;
    if ('NumericGreaterThan' in c && cur > c.NumericGreaterThan) return c.Next;
  }
  return S[estado].Default;
}

describe('state machine: ¿hay recordatorios? según rotate', () => {
  const casos = [
    // [descripción, estado, contexto, destino esperado]
    ['leído por completo, con rotación', 'RotationOnRead', { rotate: true }, 'WaitReminder'],
    ['leído por completo, SIN rotación', 'RotationOnRead', { rotate: false }, 'Closed'],
    ['leído por completo, ejecución anterior a la opción', 'RotationOnRead', {}, 'WaitReminder'],
    ['expiró con lecturas, con rotación', 'ReadBeforeExpiry', { rotate: true, expired: { reads: 2 } }, 'WaitReminder'],
    ['expiró con lecturas, SIN rotación', 'ReadBeforeExpiry', { rotate: false, expired: { reads: 2 } }, 'Closed'],
    ['expiró con lecturas, ejecución anterior a la opción', 'ReadBeforeExpiry', { expired: { reads: 2 } }, 'WaitReminder'],
    ['expiró sin lecturas, con rotación', 'ReadBeforeExpiry', { rotate: true, expired: { reads: 0 } }, 'Closed'],
    ['expiró sin lecturas, SIN rotación', 'ReadBeforeExpiry', { rotate: false, expired: { reads: 0 } }, 'Closed'],
    ['expiró sin lecturas, ejecución anterior a la opción', 'ReadBeforeExpiry', { expired: { reads: 0 } }, 'Closed'],
  ];
  for (const [nombre, estado, ctx, destino] of casos) {
    it(nombre, () => assert.equal(enrutar(estado, ctx), destino));
  }

  it('NotifyRead pasa por RotationOnRead antes de esperar el recordatorio', () => {
    assert.equal(S.NotifyRead.Next, 'RotationOnRead');
  });

  it('el ciclo de recordatorios sigue acotado: IsAcked cierra al confirmar o tras 3 intentos', () => {
    assert.equal(enrutar('IsAcked', { check: { acked: true, attempts: 0 } }), 'Closed');
    assert.equal(enrutar('IsAcked', { check: { acked: false, attempts: 3 } }), 'GiveUp');
    assert.equal(enrutar('IsAcked', { check: { acked: false, attempts: 1 } }), 'SendReminder');
  });
});
