import type { Migration, MigrationEvent, Status } from './repository';
import type { Proposal } from './schemas';

const STATUSES: Status[] = [
  'CREATED',
  'ANALYZING',
  'WAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'VALIDATING',
  'COMPLETED',
  'FAILED',
];

/** Etapa = tempo que a migração passa num status (da entrada até a próxima transição). */
const STAGES = {
  analysis: 'ANALYZING',
  approval: 'WAITING_APPROVAL',
  execution: 'EXECUTING',
  validation: 'VALIDATING',
} as const satisfies Record<string, Status>;

type StageName = keyof typeof STAGES | 'total';
type Duration = { count: number; avgMs: number | null };

const avg = (values: number[]): Duration => ({
  count: values.length,
  avgMs: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
});

/**
 * Métricas do Dashboard calculadas a partir do estado e da trilha de auditoria.
 * Função pura: recebe as migrações e os eventos (em ordem de id) e não acessa o banco.
 */
export function computeMetrics(migrations: Migration[], events: MigrationEvent[], now = new Date()) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const m of migrations) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

  const finished = byStatus.COMPLETED + byStatus.FAILED + byStatus.REJECTED;

  // Conflitos de todas as propostas: quem decidiu cada um (regra, IA, humano) e quantos a IA deferiu.
  const conflicts = { total: 0, byDecidedBy: { rule: 0, ai: 0, human: 0 }, pendingHuman: 0, deferredByAi: 0 };
  for (const m of migrations) {
    const proposal = m.proposal as Proposal | null;
    for (const c of proposal?.conflicts ?? []) {
      conflicts.total++;
      if (c.decidedBy) conflicts.byDecidedBy[c.decidedBy]++;
      else conflicts.pendingHuman++;
      // Decidido por humano = a IA tinha devolvido DEFER (a homologação exige a decisão).
      if (c.decidedBy === 'human' || c.status === 'DEFERRED') conflicts.deferredByAi++;
    }
  }

  // Durações por etapa, a partir das mudanças de status de cada migração.
  const samples: Record<StageName, number[]> = { analysis: [], approval: [], execution: [], validation: [], total: [] };
  const failuresByStage: Partial<Record<Status, number>> = {};
  const byMigration = new Map<string, MigrationEvent[]>();
  for (const e of events) {
    if (e.type === 'MIGRATION_FAILED' && e.fromStatus) {
      failuresByStage[e.fromStatus] = (failuresByStage[e.fromStatus] ?? 0) + 1;
    }
    if (e.type !== 'STATUS_CHANGED' && e.type !== 'MIGRATION_CREATED') continue;
    const list = byMigration.get(e.migrationId) ?? [];
    list.push(e);
    byMigration.set(e.migrationId, list);
  }

  for (const list of byMigration.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      const stage = (Object.keys(STAGES) as (keyof typeof STAGES)[]).find((k) => STAGES[k] === list[i].toStatus);
      if (stage) samples[stage].push(time(list[i + 1]) - time(list[i]));
    }
    const created = list.find((e) => e.type === 'MIGRATION_CREATED');
    const done = list.find((e) => e.type === 'STATUS_CHANGED' && e.toStatus === 'COMPLETED');
    if (created && done) samples.total.push(time(done) - time(created));
  }

  return {
    generatedAt: now.toISOString(),
    migrations: {
      total: migrations.length,
      byStatus,
      inProgress: byStatus.ANALYZING + byStatus.EXECUTING + byStatus.VALIDATING,
      waitingApproval: byStatus.WAITING_APPROVAL,
      successRate: finished ? Number((byStatus.COMPLETED / finished).toFixed(4)) : null,
    },
    conflicts,
    stageDurations: Object.fromEntries(
      (Object.keys(samples) as StageName[]).map((k) => [k, avg(samples[k])]),
    ) as Record<StageName, Duration>,
    failuresByStage,
  };
}

const time = (e: MigrationEvent) => new Date(e.createdAt).getTime();

export type Metrics = ReturnType<typeof computeMetrics>;
