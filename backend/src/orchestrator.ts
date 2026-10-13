import { aiLayer, dataLayer, dbLayer } from './clients';
import { logger } from './logger';
import type { Conflict, PlannedConflict, Proposal } from './schemas';
import { changeStatus, getMigration, recordEvent } from './service';

/** Conflito mecânico sai resolvido por regra; o de julgamento passa pela AI Layer (PROPOSE ou DEFER). */
async function planConflict(
  conflict: Conflict,
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): Promise<PlannedConflict> {
  if (conflict.kind === 'mechanical' && conflict.resolution) {
    return { ...conflict, status: 'RESOLVED', decidedBy: 'rule' };
  }

  const answer = await aiLayer.chat({ conflict, source: { type: source.type }, target: { type: target.type } });
  if (answer.decision === 'DEFER') {
    return { ...conflict, status: 'DEFERRED', decidedBy: null, deferReason: answer.reason };
  }
  return {
    ...conflict,
    status: 'RESOLVED',
    decidedBy: 'ai',
    resolution: answer.recommendation,
    justification: answer.justification,
    evidence: answer.evidence,
  };
}

/**
 * Análise: DB Layer (conexões, estrutura, conflitos) → AI Layer (conflitos de julgamento).
 * Chamado em background depois que a migração já está em ANALYZING.
 */
export async function runAnalysis(id: string): Promise<void> {
  logger.info({ migrationId: id }, 'analysis started');
  try {
    const m = await getMigration(id);
    const connections = await dbLayer.testConnections({ source: m.source, target: m.target });
    if (!connections.source.ok || !connections.target.ok) {
      throw new Error('Conexão recusada pelo banco de origem ou de destino');
    }

    const { tables } = await dbLayer.introspect('source');
    const diff = await dbLayer.diff({ source: m.source, target: m.target });
    const conflicts = await Promise.all(diff.conflicts.map((c) => planConflict(c, m.source, m.target)));

    const count = (by: PlannedConflict['decidedBy']) => conflicts.filter((c) => c.decidedBy === by).length;
    const pendingDecisions = count(null);
    const proposal: Proposal = {
      summary:
        `${tables.length} tabelas e ${conflicts.length} conflitos: ${count('rule')} resolvidos por regra, ` +
        `${count('ai')} propostos pela IA, ${pendingDecisions} aguardando decisão humana.`,
      tables,
      conflicts,
      pendingDecisions,
    };

    await changeStatus(id, 'WAITING_APPROVAL', { proposal }, { summary: proposal.summary });
    logger.info({ migrationId: id }, 'analysis finished');
  } catch (err) {
    await markFailed(id, err);
  }
}

/**
 * Execução: Data Layer gera o sandbox anonimizado, DB Layer valida o plano nele
 * e só então aplica no destino. Chamado em background com a migração já em EXECUTING.
 */
export async function runExecution(id: string): Promise<void> {
  logger.info({ migrationId: id }, 'execution started');
  try {
    const m = await getMigration(id);
    const plan = m.proposal as Proposal;

    const sandbox = await dataLayer.anonymize({ source: m.source, tables: plan.tables.map((t) => t.name) });
    await recordEvent(id, 'SANDBOX_READY', { datasetId: sandbox.datasetId, fidelity: sandbox.fidelity });

    await changeStatus(id, 'VALIDATING');
    const validation = await dbLayer.validatePlan({ target: m.target, plan, datasetId: sandbox.datasetId });

    // Resposta válida no formato não significa plano aprovado: reprovou, nada é escrito no destino.
    if (!validation.valid) {
      throw new Error(`Validação reprovada no sandbox: ${validation.issues.join('; ') || 'sem detalhes'}`);
    }
    await recordEvent(id, 'PLAN_VALIDATED', { checks: validation.checks });

    const apply = await dbLayer.applyPlan({ source: m.source, target: m.target, plan });
    if (!apply.applied) throw new Error('DB Layer não aplicou o plano no destino');
    await recordEvent(id, 'PLAN_APPLIED', { rowsMigrated: apply.rowsMigrated });

    await changeStatus(id, 'COMPLETED', { result: { sandbox, validation, apply } });
    logger.info({ migrationId: id }, 'execution finished');
  } catch (err) {
    await markFailed(id, err);
  }
}

async function markFailed(id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ migrationId: id, error: message }, 'operation failed');
  try {
    await changeStatus(id, 'FAILED', { error: message }, { error: message });
  } catch (persistErr) {
    logger.error({ migrationId: id, error: String(persistErr) }, 'could not mark migration as FAILED');
  }
}
