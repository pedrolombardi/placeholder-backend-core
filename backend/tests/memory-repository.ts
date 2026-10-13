// Repositório em memória usado no lugar do PostgreSQL nos testes.
import { randomUUID } from 'crypto';
import type { Migration, MigrationEvent, MigrationUpdate, Status } from '../src/repository';

export const migrations = new Map<string, Migration>();
export const events: MigrationEvent[] = [];

export function reset() {
  migrations.clear();
  events.length = 0;
}

export async function insertMigration(data: { name: string; source: object; target: object; status: Status }) {
  const now = new Date();
  const m: Migration = {
    id: randomUUID(),
    name: data.name,
    source: data.source as Record<string, unknown>,
    target: data.target as Record<string, unknown>,
    status: data.status,
    proposal: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  migrations.set(m.id, m);
  return { ...m };
}

export async function findMigration(id: string) {
  const m = migrations.get(id);
  return m ? { ...m } : null;
}

export async function listMigrations() {
  return [...migrations.values()];
}

export async function updateMigration(id: string, fields: MigrationUpdate) {
  const m = { ...migrations.get(id)!, ...fields, updatedAt: new Date() };
  migrations.set(id, m);
  return { ...m };
}

export async function insertEvent(e: { migrationId: string; type: string; fromStatus?: Status | null; toStatus?: Status | null; payload?: unknown }) {
  events.push({
    id: events.length + 1,
    migrationId: e.migrationId,
    type: e.type,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    payload: e.payload ?? null,
    createdAt: new Date(),
  });
}

export async function listEvents(migrationId: string) {
  return events.filter((e) => e.migrationId === migrationId);
}

export async function ping() {}
