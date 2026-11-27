import { computeMetrics } from '../src/metrics';
import type { Migration, MigrationEvent, Status } from '../src/repository';

const t0 = new Date('2026-11-27T12:00:00Z').getTime();
const at = (s: number) => new Date(t0 + s * 1000);

function migration(id: string, status: Status, decided: (string | null)[] = []): Migration {
  return {
    id,
    name: id,
    source: {},
    target: {},
    status,
    proposal: decided.length
      ? {
          summary: '',
          tables: [],
          pendingDecisions: 0,
          conflicts: decided.map((d, i) => ({ id: `c${i}`, decidedBy: d, status: d ? 'RESOLVED' : 'DEFERRED' })),
        }
      : null,
    result: null,
    error: null,
    createdAt: at(0),
    updatedAt: at(0),
  };
}

let seq = 0;
const ev = (migrationId: string, type: string, toStatus: Status | null, s: number, fromStatus: Status | null = null): MigrationEvent => ({
  id: ++seq,
  migrationId,
  type,
  actor: 'system',
  fromStatus,
  toStatus,
  payload: null,
  createdAt: at(s),
});

/** Linha do tempo: criação → análise (10 s) → homologação (60 s) → execução (20 s) → validação (30 s). */
const completedTimeline = (id: string): MigrationEvent[] => [
  ev(id, 'MIGRATION_CREATED', 'CREATED', 0),
  ev(id, 'STATUS_CHANGED', 'ANALYZING', 5, 'CREATED'),
  ev(id, 'STATUS_CHANGED', 'WAITING_APPROVAL', 15, 'ANALYZING'),
  ev(id, 'PROPOSAL_CREATED', 'WAITING_APPROVAL', 15, 'ANALYZING'),
  ev(id, 'STATUS_CHANGED', 'APPROVED', 75, 'WAITING_APPROVAL'),
  ev(id, 'STATUS_CHANGED', 'EXECUTING', 76, 'APPROVED'),
  ev(id, 'STATUS_CHANGED', 'VALIDATING', 96, 'EXECUTING'),
  ev(id, 'STATUS_CHANGED', 'COMPLETED', 126, 'VALIDATING'),
];

test('sem migrações: zeros e taxa de sucesso nula', () => {
  const m = computeMetrics([], []);
  expect(m.migrations.total).toBe(0);
  expect(m.migrations.successRate).toBeNull();
  expect(m.stageDurations.analysis).toEqual({ count: 0, avgMs: null });
});

test('contagem por status, taxa de sucesso, conflitos por quem decidiu e duração das etapas', () => {
  const migrations = [
    migration('a', 'COMPLETED', ['rule', 'rule', 'ai', 'human']),
    migration('b', 'FAILED', ['rule', 'ai']),
    migration('c', 'WAITING_APPROVAL', ['rule', null]),
  ];
  const events = [
    ...completedTimeline('a'),
    ev('b', 'MIGRATION_CREATED', 'CREATED', 0),
    ev('b', 'STATUS_CHANGED', 'ANALYZING', 1, 'CREATED'),
    ev('b', 'STATUS_CHANGED', 'FAILED', 31, 'ANALYZING'),
    ev('b', 'MIGRATION_FAILED', 'FAILED', 31, 'ANALYZING'),
  ];

  const m = computeMetrics(migrations, events, at(500));

  expect(m.generatedAt).toBe(at(500).toISOString());
  expect(m.migrations).toMatchObject({ total: 3, waitingApproval: 1, inProgress: 0, successRate: 0.5 });
  expect(m.migrations.byStatus).toMatchObject({ COMPLETED: 1, FAILED: 1, WAITING_APPROVAL: 1, CREATED: 0 });

  expect(m.conflicts).toEqual({
    total: 8,
    byDecidedBy: { rule: 4, ai: 2, human: 1 },
    pendingHuman: 1,
    deferredByAi: 2,
  });

  // análise: a = 10 s, b = 30 s → média 20 s
  expect(m.stageDurations.analysis).toEqual({ count: 2, avgMs: 20_000 });
  expect(m.stageDurations.approval).toEqual({ count: 1, avgMs: 60_000 });
  expect(m.stageDurations.execution).toEqual({ count: 1, avgMs: 20_000 });
  expect(m.stageDurations.validation).toEqual({ count: 1, avgMs: 30_000 });
  expect(m.stageDurations.total).toEqual({ count: 1, avgMs: 126_000 });

  expect(m.failuresByStage).toEqual({ ANALYZING: 1 });
});
