import { createApp } from './app';
import { authEnabled, seedUsers } from './auth';
import { logger } from './logger';
import { ensureSchema } from './repository';

async function main() {
  // Schema (tabela users e coluna actor) e usuários iniciais antes de aceitar requisições.
  await ensureSchema();
  await seedUsers();

  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => logger.info({ port, auth: authEnabled() }, 'backend listening'));
}

main().catch((err) => {
  logger.error({ error: String(err) }, 'backend failed to start');
  process.exit(1);
});
