import { z } from 'zod';

// ---- Requisições do Front-end ----

export const createMigrationSchema = z.object({
  name: z.string().min(1),
  source: z.object({
    type: z.enum(['mysql', 'oracle', 'sqlserver', 'postgres']),
    host: z.string().min(1),
    database: z.string().min(1),
    // aceitos por compatibilidade e descartados antes de gravar: o DB Layer usa
    // a conexão configurada nele e só confere tipo e database
    user: z.string().optional(),
    password: z.string().optional(),
  }),
  target: z.object({
    type: z.enum(['oracle', 'postgres']),
  }),
});
export type CreateMigrationInput = z.infer<typeof createMigrationSchema>;

const decision = z.object({ conflictId: z.string().min(1), resolution: z.string().min(1) });
export type Decision = z.infer<typeof decision>;

export const approveSchema = z.object({ decisions: z.array(decision).default([]) }).default({});

export const rejectSchema = z.object({ reason: z.string().optional() }).default({});

export const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

// ---- Respostas do DB Layer ----

export const connectionTestResponse = z.object({
  source: z.object({ ok: z.boolean(), readOnly: z.boolean() }),
  target: z.object({ ok: z.boolean() }),
});

const column = z.object({ name: z.string(), type: z.string() });
const table = z.object({
  name: z.string(),
  columns: z.array(column),
  foreignKeys: z.array(z.object({ column: z.string(), references: z.string() })).default([]),
});

export const introspectResponse = z.object({ tables: z.array(table) });

const conflict = z.object({
  id: z.string(),
  table: z.string(),
  column: z.string(),
  sourceType: z.string(),
  targetType: z.string(),
  // mechanical: resolvido por regra; judgement: precisa do julgamento da AI Layer.
  kind: z.enum(['mechanical', 'judgement']),
  description: z.string(),
  resolution: z.string().optional(),
});
export type Conflict = z.infer<typeof conflict>;

export const diffResponse = z.object({ conflicts: z.array(conflict) });

const validationChecks = {
  valid: z.boolean(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
  issues: z.array(z.string()).default([]),
};
export const validatePlanResponse = z.object(validationChecks);

/**
 * DB Layer real: `applied: false, mode: "script"` = plano validado e script de
 * migracao gerado para o DBA (o DB Layer nao escreve no destino).
 */
export const applyPlanResponse = z.object({
  applied: z.boolean(),
  mode: z.string().optional(),
  script: z.string().optional(),
  statements: z.number().optional(),
  tablesMigrated: z.number(),
  rowsMigrated: z.number(),
  durationMs: z.number(),
});

// ---- Resposta da AI Layer ----

export const aiChatResponse = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('PROPOSE'),
    recommendation: z.string(),
    justification: z.string(),
    evidence: z.array(z.string()).default([]),
  }),
  z.object({ decision: z.literal('DEFER'), reason: z.string() }),
]);

export type AiChatResponse = z.infer<typeof aiChatResponse>;

/** Resposta real da AI Layer (Erick): POST /ai/analyze-conflict. */
export const analyzeConflictResponse = z.object({
  conflictId: z.string(),
  verdict: z.enum(['PROPOSE', 'DEFER']),
  proposal: z.object({ targetType: z.string() }).passthrough().nullable(),
  reason: z.string(),
  simulated: z.boolean().optional(),
  evidence: z.record(z.unknown()).default({}),
});

// ---- Resposta do Data Layer ----

export const anonymizeResponse = z.object({
  datasetId: z.string(),
  tables: z.array(z.object({ name: z.string(), rows: z.number(), anonymizedColumns: z.array(z.string()) })),
  fidelity: z.number(),
  verdict: z.string().optional(),
  /** dataset anonimizado: vai para a validacao no sandbox do DB Layer */
  dataset: z.unknown().optional(),
});
export type AnonymizeResult = z.infer<typeof anonymizeResponse>;

const wireDataset = z.object({
  tables: z.array(
    z
      .object({
        name: z.string(),
        columns: z.array(z.object({ name: z.string() }).passthrough()),
        rows: z.array(z.array(z.unknown())),
      })
      .passthrough(),
  ),
});

/** DB Layer: POST /extract/sample (ja no formato de entrada do Data Layer). */
export const extractResponse = z.object({
  dataset: wireDataset,
  options: z.object({ preserve: z.array(z.string()) }).passthrough(),
});

/** Data Layer real: POST /v1/anonymize. */
export const dataLayerAnonymizeResponse = z.object({
  run_id: z.string(),
  dataset: wireDataset,
  report: z
    .object({
      verdict: z.enum(['pass', 'warn', 'fail']),
      columns: z.array(
        z.object({ column: z.string(), strategy: z.string(), total_variation_distance: z.number().nullable().optional() }).passthrough(),
      ),
      checks: z.array(z.object({ check: z.string(), verdict: z.string() }).passthrough()),
    })
    .passthrough(),
});

// ---- Proposta consolidada pelo Backend ----

export interface PlannedConflict extends Conflict {
  status: 'RESOLVED' | 'DEFERRED';
  decidedBy: 'rule' | 'ai' | 'human' | null;
  /** usuário que decidiu, quando decidedBy = human */
  decidedByUser?: string;
  resolution?: string;
  justification?: string;
  evidence?: string[];
  deferReason?: string;
}

export interface Proposal {
  summary: string;
  tables: z.infer<typeof table>[];
  conflicts: PlannedConflict[];
  pendingDecisions: number;
}

// ---- Conexões salvas (cadastro; sem senha) ----

const ENGINE_BY_ROLE = { source: 'mysql', target: 'oracle' } as const;

export const createConnectionSchema = z
  .object({
    name: z.string().min(1),
    role: z.enum(['source', 'target']),
    engine: z.enum(['mysql', 'oracle']),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    database: z.string().min(1),
    username: z.string().min(1).nullable().optional(),
  })
  .superRefine((c, ctx) => {
    if (ENGINE_BY_ROLE[c.role] !== c.engine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engine'],
        message: `engine de uma conexão ${c.role} deve ser ${ENGINE_BY_ROLE[c.role]} (a plataforma migra MySQL → Oracle)`,
      });
    }
  });
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/** DB Layer: GET /health/db. `source` e `target` são repassados como vieram. */
const healthSide = z.object({ connected: z.boolean() }).passthrough();
export const dbHealthResponse = z.object({
  status: z.string(),
  source: healthSide,
  target: healthSide,
});
export type DbHealth = z.infer<typeof dbHealthResponse>;
