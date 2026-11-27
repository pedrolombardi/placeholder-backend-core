jest.mock('../src/repository', () => require('./memory-repository'));
jest.mock('../src/orchestrator', () => ({ runAnalysis: jest.fn(), runExecution: jest.fn() }));
jest.mock('../src/clients', () => ({
  ...jest.requireActual('../src/clients'),
  dbLayerHealth: jest.fn(),
  probeHealth: jest.fn(),
}));

import request from 'supertest';
import { createApp } from '../src/app';
import { seedUsers } from '../src/auth';
import { dbLayerHealth, HealthProbe, probeHealth } from '../src/clients';
import * as service from '../src/service';
import * as memory from './memory-repository';

/** Contratos HTTP consumidos pelo front: criação de migração, conexões, configurações e script. */
const app = createApp();

const liveSource = { connected: true, engine: 'mysql', role: 'source', version: '8.0.46', schema: 'vendas', charset: 'utf8mb4', readOnly: true, latencyMs: 2 };
const liveTarget = { connected: true, engine: 'oracle', role: 'target', version: '23.26', schema: 'VENDAS', charset: 'AL32UTF8', readOnly: false, latencyMs: 3 };

const okProbe = (latencyMs = 5): HealthProbe => ({ healthy: true, status: 200, body: { status: 'ok' }, detail: null, latencyMs });
const downProbe: HealthProbe = { healthy: false, status: null, body: null, detail: 'sem resposta em 2000ms', latencyMs: null };

function dbUp(source: object = liveSource, target: object = liveTarget) {
  const status = (source as { connected: boolean }).connected && (target as { connected: boolean }).connected ? 'ok' : 'degraded';
  const body = { status, source, target };
  jest.mocked(dbLayerHealth).mockResolvedValue({
    probe: { healthy: status === 'ok', status: status === 'ok' ? 200 : 503, body, detail: status === 'ok' ? null : 'HTTP 503', latencyMs: 4 },
    health: body as never,
  });
}
const dbDown = () => jest.mocked(dbLayerHealth).mockResolvedValue({ probe: downProbe, health: null });

let dba: Record<string, string>;
let qa: Record<string, string>;

async function login(username: string, password: string) {
  const res = await request(app).post('/auth/login').send({ username, password });
  return { authorization: `Bearer ${res.body.token}` };
}

beforeEach(async () => {
  memory.reset();
  jest.resetAllMocks();
  process.env.AUTH_ENABLED = 'true';
  process.env.JWT_SECRET = 'segredo-de-teste';
  await seedUsers();
  dba = await login('dba', 'dba123');
  qa = await login('qa', 'qa123');
  dbUp();
  jest.mocked(probeHealth).mockResolvedValue(okProbe());
});

afterAll(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.JWT_SECRET;
});

const connectionBody = { name: 'Vendas MySQL', role: 'source', engine: 'mysql', host: 'mysql', port: 3306, database: 'vendas', username: 'readonly' };

// ---- POST /migrations ----

describe('POST /migrations', () => {
  const base = { name: 'vendas', source: { type: 'mysql', host: 'mysql', database: 'vendas' }, target: { type: 'oracle' } };

  test('sem user/password: 201 e nada de credencial gravada', async () => {
    const res = await request(app).post('/migrations').set(qa).send(base);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: { type: 'mysql', host: 'mysql', database: 'vendas' } });
  });

  test('user/password enviados são descartados antes de gravar', async () => {
    const res = await request(app).post('/migrations').set(dba)
      .send({ ...base, source: { ...base.source, user: 'readonly', password: 'segredo' } });
    expect(res.status).toBe(201);
    expect(JSON.stringify([...memory.migrations.values()])).not.toContain('segredo');
    expect(memory.migrations.get(res.body.id)!.source).not.toHaveProperty('user');
  });
});

// ---- Homologação pela API ----

test('POST /approve com resolução que o DB Layer não entende: 400 listando os conflitos', async () => {
  const m = await service.createMigration({ name: 'x', source: { type: 'mysql', host: 'h', database: 'd' }, target: { type: 'oracle' } });
  await service.changeStatus(m.id, 'ANALYZING');
  await service.changeStatus(m.id, 'WAITING_APPROVAL', {
    proposal: {
      summary: '', tables: [], pendingDecisions: 1,
      conflicts: [{ id: 'clientes.ativo', table: 'clientes', column: 'ativo', status: 'DEFERRED', decidedBy: null }],
    },
  });
  const res = await request(app).post(`/migrations/${m.id}/approve`).set(dba)
    .send({ decisions: [{ conflictId: 'clientes.ativo', resolution: 'decidir depois' }] });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('clientes.ativo');
});

// ---- Conexões ----

describe('/connections', () => {
  test('GET: conexões vivas do DB Layer verbatim + salvas', async () => {
    const created = await request(app).post('/connections').set(dba).send(connectionBody);
    const res = await request(app).get('/connections').set(qa);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: { status: 'ok', source: liveSource, target: liveTarget }, saved: [created.body] });
  });

  test('GET com o DB Layer fora do ar: status error, mensagem e nulls', async () => {
    dbDown();
    const res = await request(app).get('/connections').set(dba);
    expect(res.status).toBe(200);
    expect(res.body.live).toEqual({ status: 'error', source: null, target: null, error: expect.stringContaining('sem resposta em 2000ms') });
    expect(res.body.saved).toEqual([]);
  });

  test('GET com um banco fora do ar: status error, lados como vieram e o motivo', async () => {
    const down = { connected: false, code: 'CONNECTION_FAILED', error: 'ORA-12541' };
    dbUp(liveSource, down);
    const res = await request(app).get('/connections').set(dba);
    expect(res.body.live).toEqual({ status: 'error', source: liveSource, target: down, error: expect.stringContaining('destino: ORA-12541') });
  });

  test('POST (DBA): 201 no formato Connection, sem senha', async () => {
    const res = await request(app).post('/connections').set(dba).send({ ...connectionBody, password: 'segredo' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Vendas MySQL',
      role: 'source',
      engine: 'mysql',
      host: 'mysql',
      port: 3306,
      database: 'vendas',
      username: 'readonly',
      createdBy: 'dba',
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(memory.connections)).not.toContain('segredo');
  });

  test('POST sem port/username: null', async () => {
    const res = await request(app).post('/connections').set(dba)
      .send({ name: 'Oracle', role: 'target', engine: 'oracle', host: 'oracle', database: 'VENDAS' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ port: null, username: null });
  });

  test('POST com engine que não bate com o papel: 400', async () => {
    const res = await request(app).post('/connections').set(dba).send({ ...connectionBody, engine: 'oracle' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain('engine de uma conexão source deve ser mysql');
  });

  test('POST e DELETE são do DBA: DEV_QA recebe 403', async () => {
    expect((await request(app).post('/connections').set(qa).send(connectionBody)).status).toBe(403);
    const created = await request(app).post('/connections').set(dba).send(connectionBody);
    expect((await request(app).delete(`/connections/${created.body.id}`).set(qa)).status).toBe(403);
    expect(memory.connections).toHaveLength(1);
  });

  test('DELETE: 204; de novo, 404; id que não é UUID, 404', async () => {
    const created = await request(app).post('/connections').set(dba).send(connectionBody);
    const del = await request(app).delete(`/connections/${created.body.id}`).set(dba);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expect((await request(app).delete(`/connections/${created.body.id}`).set(dba)).status).toBe(404);
    const bad = await request(app).delete('/connections/nao-e-uuid').set(dba);
    expect(bad.status).toBe(404);
    expect(bad.body.error).toBe('Conexão não encontrada');
  });

  test('sem token: 401', async () => {
    expect((await request(app).get('/connections')).status).toBe(401);
  });
});

describe('POST /connections/:id/test', () => {
  const saved = async (body: object = connectionBody) => (await request(app).post('/connections').set(dba).send(body)).body.id as string;

  test('bate com a conexão viva do DB Layer e ela está de pé: ok (qualquer perfil)', async () => {
    const id = await saved();
    const res = await request(app).post(`/connections/${id}/test`).set(qa);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, detail: expect.stringContaining('ativa'), latencyMs: 2 });
  });

  test('database diferente (sem diferenciar maiúsculas) explica a divergência', async () => {
    expect((await request(app).post(`/connections/${await saved({ ...connectionBody, database: 'VENDAS' })}/test`).set(dba)).body.ok).toBe(true);
    const res = await request(app).post(`/connections/${await saved({ ...connectionBody, database: 'erp' })}/test`).set(dba);
    expect(res.body).toEqual({ ok: false, detail: expect.stringContaining('database vendas, não erp'), latencyMs: 2 });
  });

  test('conexão do papel fora do ar', async () => {
    const id = await saved({ name: 'Oracle', role: 'target', engine: 'oracle', host: 'oracle', database: 'VENDAS' });
    dbUp(liveSource, { connected: false, code: 'CONNECTION_FAILED', error: 'ORA-12541' });
    const res = await request(app).post(`/connections/${id}/test`).set(dba);
    expect(res.body).toEqual({ ok: false, detail: expect.stringContaining('ORA-12541'), latencyMs: null });
  });

  test('DB Layer indisponível', async () => {
    const id = await saved();
    dbDown();
    const res = await request(app).post(`/connections/${id}/test`).set(dba);
    expect(res.body).toEqual({ ok: false, detail: expect.stringContaining('DB Layer indisponível'), latencyMs: null });
  });

  test('conexão inexistente: 404', async () => {
    expect((await request(app).post('/connections/6f1c2a54-3b9e-4d1a-9a77-0c2f5e8b1d42/test').set(dba)).status).toBe(404);
  });
});

// ---- Configurações ----

test('GET /settings: auth, validade do token e saúde de cada layer', async () => {
  jest.mocked(probeHealth).mockImplementation(async (url: string) => (url.includes('4003') || url.includes('8081') ? downProbe : okProbe(7)));
  const res = await request(app).get('/settings').set(qa);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    authEnabled: true,
    tokenTtl: '8h',
    layers: {
      db: { url: expect.any(String), healthy: true, detail: null, latencyMs: 4 },
      ai: { url: expect.any(String), healthy: true, detail: null, latencyMs: 7 },
      data: { url: expect.any(String), healthy: false, detail: 'sem resposta em 2000ms', latencyMs: null },
    },
  });
  expect(jest.mocked(probeHealth).mock.calls.map(([url]) => url)).toEqual([
    expect.stringMatching(/\/health$/),
    expect.stringMatching(/\/health$/),
  ]);
});

test('GET /settings com o DB Layer degradado: detail diz qual banco caiu', async () => {
  dbUp({ connected: false, error: 'ECONNREFUSED' }, liveTarget);
  const res = await request(app).get('/settings').set(dba);
  expect(res.body.layers.db).toMatchObject({ healthy: false, detail: expect.stringContaining('origem: ECONNREFUSED') });
});

// ---- Script ----

describe('GET /migrations/:id/script', () => {
  async function completedWithScript(script?: string) {
    const m = await service.createMigration({ name: 'x', source: { type: 'mysql', host: 'h', database: 'd' }, target: { type: 'oracle' } });
    memory.migrations.set(m.id, { ...memory.migrations.get(m.id)!, status: 'COMPLETED', result: { apply: script ? { mode: 'script', script } : { applied: true } } });
    return m.id;
  }

  test('text/plain como anexo migracao-<id8>.sql', async () => {
    const id = await completedWithScript('ALTER TABLE "VENDAS"."CLIENTES" MODIFY ("EMAIL" VARCHAR2(300 CHAR));\n');
    const res = await request(app).get(`/migrations/${id}/script`).set(qa);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="migracao-${id.slice(0, 8)}.sql"`);
    expect(res.text).toBe('ALTER TABLE "VENDAS"."CLIENTES" MODIFY ("EMAIL" VARCHAR2(300 CHAR));\n');
  });

  test('sem script: 404 { error }', async () => {
    const id = await completedWithScript();
    const res = await request(app).get(`/migrations/${id}/script`).set(dba);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Script de migração indisponível/);
  });
});
