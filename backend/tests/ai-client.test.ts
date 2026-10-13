import { aiLayer, ServiceCallError } from '../src/clients';
import type { Conflict } from '../src/schemas';

/**
 * Traducao entre o contrato real da AI Layer (POST /ai/analyze-conflict) e o
 * formato que o orchestrator usa (decision PROPOSE | DEFER). Os demais testes
 * mockam o modulo de clients inteiro; este exercita a traducao com fetch falso.
 */
const conflict: Conflict = {
  id: 'clientes.email',
  table: 'clientes',
  column: 'email',
  sourceType: 'VARCHAR(300)',
  targetType: 'VARCHAR2(200)',
  kind: 'judgement',
  description: '2 valores excedem o tamanho declarado no destino',
};

function respond(body: unknown, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const call = () => aiLayer.chat({ conflict, source: { type: 'mysql' }, target: { type: 'oracle' } });

test('envia o conflito no formato do /ai/analyze-conflict', async () => {
  const fetchMock = respond({ conflictId: 'clientes.email', verdict: 'DEFER', proposal: null, reason: 'x', evidence: {} });
  await call();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/\/ai\/analyze-conflict$/);
  expect(JSON.parse(init.body)).toEqual({
    conflictId: 'clientes.email',
    table: 'clientes',
    column: 'email',
    source: { database: 'mysql', type: 'VARCHAR(300)' },
    target: { database: 'oracle', type: 'VARCHAR2(200)' },
  });
});

test('PROPOSE vira recommendation + evidencia legivel, sem campos de identificacao', async () => {
  respond({
    conflictId: 'clientes.email',
    verdict: 'PROPOSE',
    proposal: { targetType: 'VARCHAR2(300 CHAR)', requiresValidation: true },
    reason: '2 registros acima de 200',
    simulated: false,
    toolsUsed: ['profileColumn'],
    evidence: { profileColumn: { status: 'OK', simulated: false, table: 'clientes', valuesAboveThreshold: 2, maxObservedLength: 226 } },
  });
  expect(await call()).toEqual({
    decision: 'PROPOSE',
    recommendation: 'Usar VARCHAR2(300 CHAR)',
    justification: '2 registros acima de 200',
    evidence: ['profileColumn: valuesAboveThreshold=2, maxObservedLength=226'],
  });
});

test('evidencia simulada vem marcada', async () => {
  respond({ conflictId: 'c', verdict: 'PROPOSE', proposal: { targetType: 'T' }, reason: 'r', simulated: true, evidence: { mock: { n: 1 } } });
  const r = await call();
  expect(r.decision === 'PROPOSE' && r.evidence[0]).toBe('(simulado) mock: n=1');
});

test('DEFER preserva o motivo', async () => {
  respond({ conflictId: 'c', verdict: 'DEFER', proposal: null, reason: 'valores alem de 0 e 1', evidence: {} });
  expect(await call()).toEqual({ decision: 'DEFER', reason: 'valores alem de 0 e 1' });
});

test('resposta fora do contrato falha alto (INVALID_RESPONSE), sem retry', async () => {
  const fetchMock = respond({ decision: 'PROPOSE' });
  await expect(call()).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  await expect(call()).rejects.toBeInstanceOf(ServiceCallError);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
