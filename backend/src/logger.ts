import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // Proteção extra: os logs já são montados sem a conexão de origem.
  redact: ['source.password', 'migration.source.password'],
});
