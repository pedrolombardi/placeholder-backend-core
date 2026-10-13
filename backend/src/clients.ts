import { z } from 'zod';
import { logger } from './logger';
import {
  AiChatResponse,
  analyzeConflictResponse,
  AnonymizeResult,
  dataLayerAnonymizeResponse,
  extractResponse,
  applyPlanResponse,
  Conflict,
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
  validatePlan: (body: { target: object; plan: unknown; datasetId: string; dataset?: unknown }) =>
    post('db-layer', `${DB_LAYER_URL}/validate/plan`, body, validatePlanResponse),
  applyPlan: (body: { source: object; target: object; plan: unknown }) =>
    post('db-layer', `${DB_LAYER_URL}/plan/apply`, body, applyPlanResponse),
};

/** Evidencia da AI Layer em linhas legiveis, sem os campos de identificacao. */
function summarizeEvidence(evidence: Record<string, unknown>, simulated?: boolean): string[] {
  const skip = new Set(['status', 'simulated', 'database', 'side', 'table', 'column']);
  return Object.entries(evidence).map(([tool, data]) => {
    const fields = Object.entries((data ?? {}) as Record<string, unknown>)
      .filter(([k]) => !skip.has(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return `${simulated ? '(simulado) ' : ''}${tool}: ${fields.join(', ')}`;
  });
}

/**
 * A AI Layer real expoe POST /ai/analyze-conflict ({ verdict, proposal, reason, evidence }).
 * A resposta e traduzida para o formato que o orchestrator ja usa (decision PROPOSE | DEFER),
 * por isso o nome `chat` e a assinatura continuam os mesmos.
 */
export const aiLayer = {
  chat: async (body: { conflict: Conflict; source: { type: unknown }; target: { type: unknown } }): Promise<AiChatResponse> => {
    const { conflict } = body;
    const r = await post('ai-layer', `${AI_LAYER_URL}/ai/analyze-conflict`, {
      conflictId: conflict.id,
      table: conflict.table,
      column: conflict.column,
      source: { database: String(body.source.type), type: conflict.sourceType },
      target: { database: String(body.target.type), type: conflict.targetType },
    }, analyzeConflictResponse);
    if (r.verdict === 'DEFER') return { decision: 'DEFER', reason: r.reason };
    return {
      decision: 'PROPOSE',
      recommendation: r.proposal ? `Usar ${r.proposal.targetType}` : r.reason,
      justification: r.reason,
      evidence: summarizeEvidence(r.evidence, r.simulated),
    };
  },
};

/**
 * Sandbox anonimizado: o DB Layer extrai a amostra da origem (unico com acesso
 * de leitura) ja no formato do Data Layer, e o Data Layer anonimiza.
 * O dataset anonimizado segue para a validacao no sandbox do DB Layer.
 */
export const dataLayer = {
  anonymize: async (body: { source: object; tables: string[] }): Promise<AnonymizeResult> => {
    const request = await post('db-layer', `${DB_LAYER_URL}/extract/sample`, body, extractResponse);
    const r = await post('data-layer', `${DATA_LAYER_URL}/v1/anonymize`, request, dataLayerAnonymizeResponse);
    if (r.report.verdict === 'fail') {
      const failed = r.report.checks.filter((c) => c.verdict === 'fail').map((c) => c.check);
      throw new Error(`Data Layer reprovou a anonimizacao: ${failed.join(', ') || 'sem detalhes'}`);
    }
    const tvds = r.report.columns
      .map((c) => c.total_variation_distance)
      .filter((v): v is number => typeof v === 'number');
    return {
      datasetId: r.run_id,
      tables: r.dataset.tables.map((t) => ({
        name: t.name,
        rows: t.rows.length,
        anonymizedColumns: r.report.columns
          .filter((c) => c.column.startsWith(`${t.name}.`) && c.strategy !== 'keep')
          .map((c) => c.column.slice(t.name.length + 1)),
      })),
      fidelity: tvds.length > 0 ? Number((1 - tvds.reduce((a, b) => a + b, 0) / tvds.length).toFixed(4)) : 1,
      verdict: r.report.verdict,
      dataset: r.dataset,
    };
  },
};
