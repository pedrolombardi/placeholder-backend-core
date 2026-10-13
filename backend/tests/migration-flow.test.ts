jest.mock('../src/repository', () => require('./memory-repository'));
jest.mock('../src/clients', () => ({
  ...jest.requireActual('../src/clients'),
  dbLayer: {
    testConnections: jest.fn(),
    introspect: jest.fn(),
    diff: jest.fn(),
    validatePlan: jest.fn(),
    applyPlan: jest.fn(),
  },
  dataLayer: { anonymize: jest.fn() },
  aiLayer: { chat: jest.fn() },
}));

import { aiLayer, dataLayer, dbLayer, ServiceCallError } from '../src/clients';
import { runAnalysis, runExecution } from '../src/orchestrator';
import type { Proposal } from '../src/schemas';
import * as service from '../src/service';
import * as memory from './memory-repository';

const input = {
  name: 'ERP legado',
  source: { type: 'mysql' as const, host: 'db.local', database: 'erp', user: 'demo', password: 'senha-ficticia' },
  target: { type: 'oracle' as const },
};

const conflict = (id: string, kind: 'mechanical' | 'judgement', resolution?: string) => ({
  id,
  table: 'clientes',
  column: id,
  sourceType: 'A',
  targetType: 'B',
  kind,
  description: 'conflito de teste',
  resolution,
});

const propose = {
  decision: 'PROPOSE' as const,
  recommendation: 'Ampliar a coluna',
  justification: 'Há valores maiores',
  evidence: ['max=287'],
};
const defer = { decision: 'DEFER' as const, reason: 'Evidências insuficientes' };

beforeEach(() => {
  memory.reset();
  jest.resetAllMocks();
  jest.mocked(dbLayer.testConnections).mockResolvedValue({ source: { ok: true, readOnly: true }, target: { ok: true } });
  jest.mocked(dbLayer.introspect).mockResolvedValue({ tables: [{ name: 'clientes', columns: [], foreignKeys: [] }] });
  jest.mocked(dbLayer.diff).mockResolvedValue({
    conflicts: [conflict('id', 'mechanical', 'IDENTITY'), conflict('nome', 'judgement')],
  });
  jest.mocked(aiLayer.chat).mockResolvedValue(propose);
  jest.mocked(dataLayer.anonymize).mockResolvedValue({ datasetId: 'sandbox-1', tables: [], fidelity: 0.97 });
  jest.mocked(dbLayer.validatePlan).mockResolvedValue({ valid: true, checks: [], issues: [] });
  jest.mocked(dbLayer.applyPlan).mockResolvedValue({ applied: true, tablesMigrated: 1, rowsMigrated: 1500, durationMs: 800 });
});

const eventTypes = (id: string) => memory.events.filter((e) => e.migrationId === id).map((e) => e.type);

async function analyzed() {
  const { id } = await service.createMigration(input);
  await service.startAnalysis(id);
  await runAnalysis(id);
  return id;
}

test('fluxo feliz: criar → analisar → aprovar → executar → concluir', async () => {
  const id = await analyzed();
  let m = await service.getMigration(id);
  expect(m.status).toBe('WAITING_APPROVAL');
  expect((m.proposal as Proposal).conflicts.map((c) => c.decidedBy)).toEqual(['rule', 'ai']);
  // Só o conflito de julgamento vai para a AI Layer.
  expect(aiLayer.chat).toHaveBeenCalledTimes(1);

  await service.approve(id);
  await service.startExecution(id);
  await runExecution(id);
  m = await service.getMigration(id);
  expect(m.status).toBe('COMPLETED');
  expect(m.result).toMatchObject({ apply: { rowsMigrated: 1500 }, sandbox: { datasetId: 'sandbox-1' } });

  expect(eventTypes(id)).toEqual(
    expect.arrayContaining([
      'MIGRATION_CREATED',
      'PROPOSAL_CREATED',
      'PROPOSAL_APPROVED',
      'SANDBOX_READY',
      'PLAN_VALIDATED',
      'PLAN_APPLIED',
      'MIGRATION_COMPLETED',
    ]),
  );
});

test('DB Layer real: plano validado vira script de migracao (mode script) e a migracao completa', async () => {
  jest.mocked(dbLayer.applyPlan).mockResolvedValue({
    applied: false, mode: 'script', script: 'ALTER TABLE ...;', statements: 1, tablesMigrated: 3, rowsMigrated: 0, durationMs: 50,
  });
  const { id } = await service.createMigration(input);
  await service.startAnalysis(id);
  await runAnalysis(id);
  await service.approve(id);
  await service.startExecution(id);
  await runExecution(id);
  const m = await service.getMigration(id);
  expect(m.status).toBe('COMPLETED');
  expect(m.result).toMatchObject({ apply: { mode: 'script', script: 'ALTER TABLE ...;' } });
  expect(eventTypes(id)).toEqual(expect.arrayContaining(['PLAN_SCRIPT_READY', 'MIGRATION_COMPLETED']));
  expect(eventTypes(id)).not.toContain('PLAN_APPLIED');
});

test('transição inválida: aprovar uma migração em CREATED retorna 409', async () => {
  const { id } = await service.createMigration(input);

  await expect(service.approve(id)).rejects.toMatchObject({ status: 409 });
  expect((await service.getMigration(id)).status).toBe('CREATED');
});

test('DEFER da IA: aprovar sem decisão humana retorna 422', async () => {
  jest.mocked(aiLayer.chat).mockResolvedValue(defer);
  const id = await analyzed();
  expect((await service.getMigration(id)).proposal).toMatchObject({ pendingDecisions: 1 });

  await expect(service.approve(id)).rejects.toMatchObject({ status: 422 });
  expect((await service.getMigration(id)).status).toBe('WAITING_APPROVAL');
});

test('DEFER da IA: a decisão humana fica registrada na proposta e no evento', async () => {
  jest.mocked(aiLayer.chat).mockResolvedValue(defer);
  const id = await analyzed();
  const decisions = [{ conflictId: 'nome', resolution: 'Truncar em 200' }];

  const m = await service.approve(id, decisions);
  expect(m.status).toBe('APPROVED');
  expect((m.proposal as Proposal).conflicts[1]).toMatchObject({
    status: 'RESOLVED',
    decidedBy: 'human',
    resolution: 'Truncar em 200',
  });
  const approved = memory.events.find((e) => e.type === 'PROPOSAL_APPROVED');
  expect(approved?.payload).toEqual({ decisions });
});

test('decisão para um conflito que não existe retorna 400', async () => {
  const id = await analyzed();

  await expect(service.approve(id, [{ conflictId: 'nao-existe', resolution: 'x' }])).rejects.toMatchObject({
    status: 400,
  });
});

test('falha de um layer: a migração termina em FAILED com o erro registrado', async () => {
  jest.mocked(aiLayer.chat).mockRejectedValue(new ServiceCallError('ai-layer', 'UNAVAILABLE', 'HTTP 500'));
  const id = await analyzed();

  const m = await service.getMigration(id);
  expect(m.status).toBe('FAILED');
  expect(m.error).toContain('ai-layer');
  expect(eventTypes(id)).toContain('MIGRATION_FAILED');
});

test('validação reprovada no sandbox: FAILED e nada é aplicado no destino', async () => {
  jest.mocked(dbLayer.validatePlan).mockResolvedValue({ valid: false, checks: [], issues: ['Contagem divergente'] });
  const id = await analyzed();
  await service.approve(id);
  await service.startExecution(id);
  await runExecution(id);

  const m = await service.getMigration(id);
  expect(m.status).toBe('FAILED');
  expect(m.error).toContain('Contagem divergente');
  expect(dbLayer.applyPlan).not.toHaveBeenCalled();
});

test('a resposta pública não expõe usuário e senha da origem', async () => {
  const m = await service.createMigration(input);
  const json = JSON.stringify(service.publicMigration(m));
  expect(json).not.toContain('senha-ficticia');
  expect(json).not.toContain('"user"');
});
