import type { Request, Response } from 'express';
import * as auth from './auth';
import { computeMetrics } from './metrics';
import * as orchestrator from './orchestrator';
import * as repo from './repository';
import * as connections from './connections';
import { approveSchema, createConnectionSchema, createMigrationSchema, loginSchema, rejectSchema } from './schemas';
import * as service from './service';

type Params = { id: string };

/** Autor das ações na auditoria (o middleware authenticate sempre preenche req.user). */
const actor = (req: Request) => req.user?.username ?? 'anonymous';

// ---- Autenticação ----

export async function login(req: Request, res: Response) {
  const { username, password } = loginSchema.parse(req.body ?? {});
  res.json(await auth.login(username, password));
}

export async function me(req: Request, res: Response) {
  res.json({ user: req.user, authEnabled: auth.authEnabled() });
}

// ---- Migrações ----

export async function createMigration(req: Request, res: Response) {
  const input = createMigrationSchema.parse(req.body);
  const migration = await service.createMigration(input, actor(req));
  res.status(201).json(service.publicMigration(migration));
}

export async function listMigrations(_req: Request, res: Response) {
  const migrations = await service.listMigrations();
  res.json(migrations.map(service.publicMigration));
}

export async function getMigration(req: Request<Params>, res: Response) {
  res.json(service.publicMigration(await service.getMigration(req.params.id)));
}

export async function listEvents(req: Request<Params>, res: Response) {
  res.json(await service.listEvents(req.params.id));
}

export async function analyze(req: Request<Params>, res: Response) {
  const migration = await service.startAnalysis(req.params.id, actor(req));
  void orchestrator.runAnalysis(migration.id);
  res.status(202).json({ id: migration.id, status: migration.status });
}

export async function approve(req: Request<Params>, res: Response) {
  const { decisions } = approveSchema.parse(req.body ?? {});
  res.json(service.publicMigration(await service.approve(req.params.id, decisions, actor(req))));
}

export async function reject(req: Request<Params>, res: Response) {
  const { reason } = rejectSchema.parse(req.body ?? {});
  res.json(service.publicMigration(await service.reject(req.params.id, reason, actor(req))));
}

export async function execute(req: Request<Params>, res: Response) {
  const migration = await service.startExecution(req.params.id, actor(req));
  void orchestrator.runExecution(migration.id);
  res.status(202).json({ id: migration.id, status: migration.status });
}

export async function script(req: Request<Params>, res: Response) {
  const body = await service.migrationScript(req.params.id);
  // O id já passou pela busca no banco (UUID): o nome do arquivo não precisa de escape.
  res
    .type('text/plain; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="migracao-${req.params.id.slice(0, 8)}.sql"`)
    .send(body);
}

// ---- Conexões e configurações ----

export async function listConnections(_req: Request, res: Response) {
  res.json(await connections.listConnections());
}

export async function createConnection(req: Request, res: Response) {
  const input = createConnectionSchema.parse(req.body ?? {});
  res.status(201).json(await connections.createConnection(input, actor(req)));
}

export async function deleteConnection(req: Request<Params>, res: Response) {
  await connections.deleteConnection(req.params.id);
  res.status(204).end();
}

export async function testConnection(req: Request<Params>, res: Response) {
  res.json(await connections.testConnection(req.params.id));
}

export async function settings(_req: Request, res: Response) {
  res.json(await connections.settings());
}

// ---- Métricas ----

export async function metrics(_req: Request, res: Response) {
  const [migrations, events] = await Promise.all([repo.listMigrations(), repo.listAllEvents()]);
  res.json(computeMetrics(migrations, events));
}
