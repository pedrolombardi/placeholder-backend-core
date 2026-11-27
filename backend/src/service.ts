import { logger } from './logger';
import * as repo from './repository';
import type { Migration, Status } from './repository';
import type { CreateMigrationInput, Decision, Proposal } from './schemas';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const transitions: Partial<Record<Status, Status[]>> = {
  CREATED: ['ANALYZING'],
  ANALYZING: ['WAITING_APPROVAL', 'FAILED'],
  WAITING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['EXECUTING'],
  EXECUTING: ['VALIDATING', 'FAILED'],
  VALIDATING: ['COMPLETED', 'FAILED'],
};

// Eventos de negócio gravados além do STATUS_CHANGED.
const businessEvents: Partial<Record<Status, string>> = {
  WAITING_APPROVAL: 'PROPOSAL_CREATED',
  APPROVED: 'PROPOSAL_APPROVED',
  REJECTED: 'PROPOSAL_REJECTED',
  COMPLETED: 'MIGRATION_COMPLETED',
  FAILED: 'MIGRATION_FAILED',
};

/** Versão da migração devolvida ao Front-end: sem usuário e senha da origem. */
export function publicMigration(m: Migration) {
  const { user, password, ...source } = m.source;
  return { ...m, source };
}

/** Autor gravado na auditoria quando a ação vem do processamento em background. */
export const SYSTEM_ACTOR = 'system';

export async function createMigration(input: CreateMigrationInput, actor = SYSTEM_ACTOR): Promise<Migration> {
  const migration = await repo.insertMigration({ ...input, status: 'CREATED' });
  await repo.insertEvent({ migrationId: migration.id, type: 'MIGRATION_CREATED', actor, toStatus: 'CREATED' });
  logger.info({ migrationId: migration.id, actor }, 'migration created');
  return migration;
}

export async function getMigration(id: string): Promise<Migration> {
  const migration = await repo.findMigration(id);
  if (!migration) throw new HttpError(404, 'Migração não encontrada');
  return migration;
}

export async function changeStatus(
  id: string,
  to: Status,
  patch: Omit<repo.MigrationUpdate, 'status'> = {},
  eventPayload?: object,
  actor = SYSTEM_ACTOR,
): Promise<Migration> {
  const current = await getMigration(id);
  const from = current.status;
  if (!transitions[from]?.includes(to)) {
    throw new HttpError(409, `Transição inválida: ${from} → ${to}`);
  }

  const updated = await repo.updateMigration(id, { ...patch, status: to });
  await repo.insertEvent({ migrationId: id, type: 'STATUS_CHANGED', actor, fromStatus: from, toStatus: to });
  const businessEvent = businessEvents[to];
  if (businessEvent) {
    await repo.insertEvent({ migrationId: id, type: businessEvent, actor, fromStatus: from, toStatus: to, payload: eventPayload });
  }
  logger.info({ migrationId: id, from, to, actor }, 'status changed');
  return updated;
}

/** Evento de etapa, sem mudança de status. */
export const recordEvent = (id: string, type: string, payload?: object, actor = SYSTEM_ACTOR) =>
  repo.insertEvent({ migrationId: id, type, actor, payload });

export const startAnalysis = (id: string, actor = SYSTEM_ACTOR) => changeStatus(id, 'ANALYZING', {}, undefined, actor);

/**
 * Homologação: todo conflito que a IA devolveu como DEFER precisa de uma decisão humana.
 * As decisões ficam gravadas na proposta e no evento de aprovação.
 */
export async function approve(id: string, decisions: Decision[] = [], actor = SYSTEM_ACTOR): Promise<Migration> {
  const current = await getMigration(id);
  if (current.status !== 'WAITING_APPROVAL') {
    throw new HttpError(409, `Transição inválida: ${current.status} → APPROVED`);
  }

  const proposal = current.proposal as Proposal;
  const unknown = decisions.filter((d) => !proposal.conflicts.some((c) => c.id === d.conflictId));
  if (unknown.length > 0) {
    throw new HttpError(400, `Conflito inexistente na proposta: ${unknown.map((d) => d.conflictId).join(', ')}`);
  }

  const conflicts = proposal.conflicts.map((c) => {
    const decision = decisions.find((d) => d.conflictId === c.id);
    return decision
      ? { ...c, status: 'RESOLVED' as const, decidedBy: 'human' as const, decidedByUser: actor, resolution: decision.resolution }
      : c;
  });
  const pending = conflicts.filter((c) => c.status === 'DEFERRED');
  if (pending.length > 0) {
    throw new HttpError(422, `Decisão humana pendente para: ${pending.map((c) => c.id).join(', ')}`);
  }

  return changeStatus(
    id,
    'APPROVED',
    { proposal: { ...proposal, conflicts, pendingDecisions: 0 } },
    { decisions, approvedBy: actor },
    actor,
  );
}

export const reject = (id: string, reason?: string, actor = SYSTEM_ACTOR) =>
  changeStatus(id, 'REJECTED', {}, { reason: reason ?? null, rejectedBy: actor }, actor);
export const startExecution = (id: string, actor = SYSTEM_ACTOR) => changeStatus(id, 'EXECUTING', {}, undefined, actor);

export const listMigrations = () => repo.listMigrations();
export const listEvents = async (id: string) => {
  await getMigration(id);
  return repo.listEvents(id);
};
