import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger';
import { ping } from './repository';
import { router } from './routes';
import { HttpError } from './service';

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  await ping();
  res.json({ status: 'ok' });
});

app.use(router);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Dados inválidos', issues: err.issues });
  } else if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err?.code === '22P02') {
    // id que não é um UUID válido
    res.status(404).json({ error: 'Migração não encontrada' });
  } else {
    logger.error({ error: String(err) }, 'unhandled error');
    res.status(500).json({ error: 'Erro interno' });
  }
};
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => logger.info({ port }, 'backend listening'));
