import { Pool } from 'pg';

export type Status =
  | 'CREATED'
  | 'ANALYZING'
  | 'WAITING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED';

export interface Migration {
  id: string;
  name: string;
  source: Record<string, unknown>;
  target: Record<string, unknown>;
  status: Status;
  proposal: unknown | null;
  result: unknown | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MigrationEvent {
  id: number;
  migrationId: string;
  type: string;
  /** quem disparou: usuário autenticado, `anonymous` (auth desligada) ou `system` (background) */
  actor: string | null;
  fromStatus: Status | null;
  toStatus: Status | null;
  payload: unknown;
  createdAt: Date;
}

export type MigrationUpdate = Partial<Pick<Migration, 'status' | 'proposal' | 'result' | 'error'>>;

export type Role = 'DBA' | 'DEV_QA';

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function toMigration(row: any): Migration {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    target: row.target,
    status: row.status,
    proposal: row.proposal,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: any): MigrationEvent {
  return {
    id: row.id,
    migrationId: row.migration_id,
    type: row.type,
    actor: row.actor ?? null,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export async function insertMigration(data: {
  name: string;
  source: object;
  target: object;
  status: Status;
}): Promise<Migration> {
  const { rows } = await pool.query(
    `INSERT INTO migrations (name, source, target, status) VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.name, data.source, data.target, data.status],
  );
  return toMigration(rows[0]);
}

export async function findMigration(id: string): Promise<Migration | null> {
  const { rows } = await pool.query(`SELECT * FROM migrations WHERE id = $1`, [id]);
  return rows[0] ? toMigration(rows[0]) : null;
}

export async function listMigrations(): Promise<Migration[]> {
  const { rows } = await pool.query(`SELECT * FROM migrations ORDER BY created_at DESC`);
  return rows.map(toMigration);
}

export async function updateMigration(id: string, fields: MigrationUpdate): Promise<Migration> {
  const columns = Object.keys(fields) as (keyof MigrationUpdate)[];
  const sets = columns.map((col, i) => `${col} = $${i + 2}`);
  const { rows } = await pool.query(
    `UPDATE migrations SET ${[...sets, 'updated_at = NOW()'].join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...columns.map((col) => fields[col])],
  );
  return toMigration(rows[0]);
}

export async function insertEvent(event: {
  migrationId: string;
  type: string;
  actor?: string | null;
  fromStatus?: Status | null;
  toStatus?: Status | null;
  payload?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO migration_events (migration_id, type, actor, from_status, to_status, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event.migrationId, event.type, event.actor ?? null, event.fromStatus ?? null, event.toStatus ?? null, event.payload ?? null],
  );
}

export async function listEvents(migrationId: string): Promise<MigrationEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM migration_events WHERE migration_id = $1 ORDER BY id`,
    [migrationId],
  );
  return rows.map(toEvent);
}

/** Todos os eventos, em ordem: base das métricas. */
export async function listAllEvents(): Promise<MigrationEvent[]> {
  const { rows } = await pool.query(`SELECT * FROM migration_events ORDER BY id`);
  return rows.map(toEvent);
}

function toUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function insertUser(data: { username: string; passwordHash: string; role: Role }): Promise<User> {
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING *`,
    [data.username, data.passwordHash, data.role],
  );
  return toUser(rows[0]);
}

export async function countUsers(): Promise<number> {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
  return rows[0].n;
}

/**
 * Cria o que faltar no schema. O init.sql só roda no primeiro boot do PostgreSQL;
 * isto atualiza também um volume antigo (da Fase 6) sem apagar dados.
 */
export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    source      JSONB NOT NULL,
    target      JSONB NOT NULL,
    status      TEXT NOT NULL,
    proposal    JSONB,
    result      JSONB,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS migration_events (
    id            SERIAL PRIMARY KEY,
    migration_id  UUID NOT NULL REFERENCES migrations(id),
    type          TEXT NOT NULL,
    from_status   TEXT,
    to_status     TEXT,
    payload       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE migration_events ADD COLUMN IF NOT EXISTS actor TEXT;
  CREATE INDEX IF NOT EXISTS migration_events_migration_idx ON migration_events (migration_id, id);
  CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('DBA', 'DEV_QA')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}
