import type { Request, Response } from 'express';
import * as orchestrator from './orchestrator';
import { approveSchema, createMigrationSchema, rejectSchema } from './schemas';
import * as service from './service';

type Params = { id: string };

export async function createMigration(req: Request, res: Response) {
  const input = createMigrationSchema.parse(req.body);
  const migration = await service.createMigration(input);
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
  const migration = await service.startAnalysis(req.params.id);
  void orchestrator.runAnalysis(migration.id);
  res.status(202).json({ id: migration.id, status: migration.status });
}

export async function approve(req: Request<Params>, res: Response) {
  const { decisions } = approveSchema.parse(req.body ?? {});
  res.json(service.publicMigration(await service.approve(req.params.id, decisions)));
}

export async function reject(req: Request<Params>, res: Response) {
  const { reason } = rejectSchema.parse(req.body ?? {});
  res.json(service.publicMigration(await service.reject(req.params.id, reason)));
}

export async function execute(req: Request<Params>, res: Response) {
  const migration = await service.startExecution(req.params.id);
  void orchestrator.runExecution(migration.id);
  res.status(202).json({ id: migration.id, status: migration.status });
}
