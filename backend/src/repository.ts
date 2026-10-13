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
  fromStatus: Status | null;
  toStatus: Status | null;
  payload: unknown;
  createdAt: Date;
}

export type MigrationUpdate = Partial<Pick<Migration, 'status' | 'proposal' | 'result' | 'error'>>;

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
  fromStatus?: Status | null;
  toStatus?: Status | null;
  payload?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO migration_events (migration_id, type, from_status, to_status, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [event.migrationId, event.type, event.fromStatus ?? null, event.toStatus ?? null, event.payload ?? null],
  );
}

export async function listEvents(migrationId: string): Promise<MigrationEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM migration_events WHERE migration_id = $1 ORDER BY id`,
    [migrationId],
  );
  return rows.map(toEvent);
}

export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}
