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
