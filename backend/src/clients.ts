import { z } from 'zod';
import { logger } from './logger';
import {
  aiChatResponse,
  anonymizeResponse,
  applyPlanResponse,
  connectionTestResponse,
  diffResponse,
  introspectResponse,
  validatePlanResponse,
} from './schemas';

const AI_LAYER_URL = process.env.AI_LAYER_URL ?? 'http://localhost:4001';
const DB_LAYER_URL = process.env.DB_LAYER_URL ?? 'http://localhost:4002';
const DATA_LAYER_URL = process.env.DATA_LAYER_URL ?? 'http://localhost:4003';
const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 3000);
const RETRIES = Number(process.env.HTTP_RETRIES ?? 2);

export class ServiceCallError extends Error {
  constructor(
    public service: string,
    public reason: 'TIMEOUT' | 'UNAVAILABLE' | 'BAD_REQUEST' | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(`${service}: ${message}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chamada HTTP com timeout, retry (erro de rede, timeout ou 5xx) e validação da resposta.
 * O body não é logado porque pode conter credenciais de conexão.
 */
export async function httpCall<T>(
  service: string,
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  let lastError: ServiceCallError | undefined;

  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      logger.info({ service, method, url, attempt, status: res.status, ms: Date.now() - started }, 'service call');

      if (res.status >= 500) {
        lastError = new ServiceCallError(service, 'UNAVAILABLE', `HTTP ${res.status}`);
      } else if (!res.ok) {
        // 4xx: repetir não resolve.
        throw new ServiceCallError(service, 'BAD_REQUEST', `HTTP ${res.status}`);
      } else {
        const parsed = schema.safeParse(await res.json());
        if (!parsed.success) {
          throw new ServiceCallError(service, 'INVALID_RESPONSE', 'resposta fora do contrato esperado');
        }
        return parsed.data;
      }
    } catch (err) {
      if (err instanceof ServiceCallError) throw err;
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      lastError = new ServiceCallError(
        service,
        timedOut ? 'TIMEOUT' : 'UNAVAILABLE',
        timedOut ? `sem resposta em ${TIMEOUT_MS}ms` : 'serviço indisponível',
      );
      logger.warn({ service, url, attempt, reason: lastError.reason }, 'service call failed');
    }

    if (attempt <= RETRIES) await sleep(200 * 2 ** (attempt - 1));
  }

  throw lastError!;
}

const post = <T>(service: string, url: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>) =>
  httpCall(service, 'POST', url, body, schema);

export const dbLayer = {
  testConnections: (body: { source: object; target: object }) =>
    post('db-layer', `${DB_LAYER_URL}/connections/test`, body, connectionTestResponse),
  introspect: (connection: 'source' | 'target') =>
    httpCall('db-layer', 'GET', `${DB_LAYER_URL}/schema/introspect?connection=${connection}`, undefined, introspectResponse),
  diff: (body: { source: object; target: object }) =>
    post('db-layer', `${DB_LAYER_URL}/schema/diff`, body, diffResponse),
  validatePlan: (body: { target: object; plan: unknown; datasetId: string }) =>
    post('db-layer', `${DB_LAYER_URL}/validate/plan`, body, validatePlanResponse),
  applyPlan: (body: { source: object; target: object; plan: unknown }) =>
    post('db-layer', `${DB_LAYER_URL}/plan/apply`, body, applyPlanResponse),
};

export const aiLayer = {
  chat: (body: { conflict: unknown; source: { type: unknown }; target: { type: unknown } }) =>
    post('ai-layer', `${AI_LAYER_URL}/ai/chat`, body, aiChatResponse),
};

export const dataLayer = {
  anonymize: (body: { source: object; tables: string[] }) =>
    post('data-layer', `${DATA_LAYER_URL}/anonymize`, body, anonymizeResponse),
};
