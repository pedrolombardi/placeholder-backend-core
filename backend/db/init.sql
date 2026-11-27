-- Schema do Backend Core. O backend também aplica este schema no boot
-- (repository.ensureSchema), o que atualiza volumes criados na Fase 6.
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
  actor         TEXT,
  from_status   TEXT,
  to_status     TEXT,
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS migration_events_migration_idx ON migration_events (migration_id, id);

-- Usuários e perfis (RBAC): DBA homologa e executa; DEV_QA cria, analisa e consulta.
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('DBA', 'DEV_QA')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Credenciais da origem nunca foram usadas pelo DB Layer: remove as gravadas antes.
UPDATE migrations SET source = source - 'password' - 'user' WHERE source ? 'password' OR source ? 'user';
-- Conexões cadastradas pelo DBA (sem senha: o DB Layer usa as credenciais configuradas nele).
CREATE TABLE IF NOT EXISTS connections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('source', 'target')),
  engine      TEXT NOT NULL CHECK (engine IN ('mysql', 'oracle')),
  host        TEXT NOT NULL,
  port        INTEGER,
  database    TEXT NOT NULL,
  username    TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
