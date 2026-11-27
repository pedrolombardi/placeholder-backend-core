jest.mock('../src/repository', () => require('./memory-repository'));
jest.mock('../src/orchestrator', () => ({ runAnalysis: jest.fn(), runExecution: jest.fn() }));

import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword, parseSeedUsers, seedUsers, verifyPassword } from '../src/auth';
import * as service from '../src/service';
import * as memory from './memory-repository';

/**
 * Login e perfis (RBAC). Com AUTH_ENABLED=true, sem token → 401 e DEV_QA homologando → 403.
 * Com a auth desligada (padrão, usado pelo front atual), tudo segue como antes.
 */
const app = createApp();

const input = {
  name: 'ERP legado',
  source: { type: 'mysql', host: 'db.local', database: 'erp', user: 'demo', password: 'senha-ficticia' },
  target: { type: 'oracle' },
};

async function waitingApproval() {
  const m = await service.createMigration(input as never);
  await service.startAnalysis(m.id);
  await service.changeStatus(m.id, 'WAITING_APPROVAL', {
    proposal: { summary: 'teste', tables: [], conflicts: [], pendingDecisions: 0 },
  });
  return m.id;
}

async function tokenFor(username: string, password: string) {
  const res = await request(app).post('/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeEach(async () => {
  memory.reset();
  process.env.AUTH_ENABLED = 'true';
  process.env.JWT_SECRET = 'segredo-de-teste';
  delete process.env.AUTH_SEED_USERS;
  await seedUsers();
});

afterAll(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.JWT_SECRET;
});

test('senha: hash com salt, verificação e senha errada', async () => {
  const hash = await hashPassword('dba123');
  expect(hash).not.toContain('dba123');
  expect(await hashPassword('dba123')).not.toBe(hash);
  expect(await verifyPassword('dba123', hash)).toBe(true);
  expect(await verifyPassword('errada', hash)).toBe(false);
});

test('usuários iniciais: dba (DBA) e qa (DEV_QA), criados uma vez só', async () => {
  expect(memory.users.map((u) => [u.username, u.role])).toEqual([
    ['dba', 'DBA'],
    ['qa', 'DEV_QA'],
  ]);
  await seedUsers();
  expect(memory.users).toHaveLength(2);
  expect(() => parseSeedUsers('fulano:123:ADMIN')).toThrow('AUTH_SEED_USERS inválido');
});

test('login: credencial correta devolve token; errada devolve 401', async () => {
  const ok = await request(app).post('/auth/login').send({ username: 'dba', password: 'dba123' });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ tokenType: 'Bearer', user: { username: 'dba', role: 'DBA' } });

  const wrong = await request(app).post('/auth/login').send({ username: 'dba', password: 'x' });
  expect(wrong.status).toBe(401);
  const unknown = await request(app).post('/auth/login').send({ username: 'ninguem', password: 'x' });
  expect(unknown.status).toBe(401);
  expect(unknown.body.error).toBe(wrong.body.error);

  const invalid = await request(app).post('/auth/login').send({});
  expect(invalid.status).toBe(400);
});

test('sem token ou com token inválido: 401', async () => {
  expect((await request(app).get('/migrations')).status).toBe(401);
  expect((await request(app).get('/migrations').set('authorization', 'Bearer abc')).status).toBe(401);
  // /health continua público
  expect((await request(app).get('/health')).status).toBe(200);
});

test('GET /auth/me devolve o usuário do token', async () => {
  const token = await tokenFor('qa', 'qa123');
  const res = await request(app).get('/auth/me').set('authorization', `Bearer ${token}`);
  expect(res.body).toEqual({ user: { username: 'qa', role: 'DEV_QA' }, authEnabled: true });
});

test('DEV_QA cria e consulta, mas não homologa nem executa (403)', async () => {
  const token = await tokenFor('qa', 'qa123');
  const auth = { authorization: `Bearer ${token}` };

  const created = await request(app).post('/migrations').set(auth).send(input);
  expect(created.status).toBe(201);
  expect((await request(app).get('/migrations').set(auth)).status).toBe(200);
  expect((await request(app).get('/metrics').set(auth)).status).toBe(200);

  const id = await waitingApproval();
  for (const action of ['approve', 'reject', 'execute']) {
    const res = await request(app).post(`/migrations/${id}/${action}`).set(auth).send({});
    expect(res.status).toBe(403);
  }
  expect((await service.getMigration(id)).status).toBe('WAITING_APPROVAL');
});

test('DBA aprova, e a auditoria registra quem aprovou', async () => {
  const qa = await tokenFor('qa', 'qa123');
  const created = await request(app).post('/migrations').set('authorization', `Bearer ${qa}`).send(input);
  const id = created.body.id;
  await service.startAnalysis(id);
  await service.changeStatus(id, 'WAITING_APPROVAL', {
    proposal: { summary: 'teste', tables: [], conflicts: [], pendingDecisions: 0 },
  });

  const dba = await tokenFor('dba', 'dba123');
  const res = await request(app).post(`/migrations/${id}/approve`).set('authorization', `Bearer ${dba}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('APPROVED');

  const events = await request(app).get(`/migrations/${id}/events`).set('authorization', `Bearer ${dba}`);
  const byType = Object.fromEntries(events.body.map((e: { type: string; actor: string }) => [e.type, e.actor]));
  expect(byType.MIGRATION_CREATED).toBe('qa');
  expect(byType.PROPOSAL_APPROVED).toBe('dba');
});

test('auth desligada (padrão do front atual): sem token, tudo funciona como antes', async () => {
  process.env.AUTH_ENABLED = 'false';
  const created = await request(app).post('/migrations').send(input);
  expect(created.status).toBe(201);
  const id = await waitingApproval();
  const res = await request(app).post(`/migrations/${id}/approve`).send({});
  expect(res.status).toBe(200);
  const events = await request(app).get(`/migrations/${id}/events`);
  expect(events.body.find((e: { type: string }) => e.type === 'PROPOSAL_APPROVED').actor).toBe('anonymous');
});
