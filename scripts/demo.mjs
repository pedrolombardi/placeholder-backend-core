/**
 * Roda o roteiro do requests.http contra o backend.
 * Uso: node scripts/demo.mjs [approve|reject|invalid|deferred]
 *   approve (padrão): fluxo completo até COMPLETED, decidindo os conflitos que a IA devolveu como DEFER
 *   reject:           rejeita a proposta e termina em REJECTED
 *   invalid:          tenta executar sem aprovação e mostra o 409
 *   deferred:         tenta aprovar sem decidir os DEFER e mostra o 422
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const mode = process.argv[2] ?? 'approve';
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const MODES = ['approve', 'reject', 'invalid', 'deferred'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  console.log(`\n${method} ${path} -> ${res.status}`);
  return { status: res.status, data };
}

/** Consulta a migração até ela sair dos estados de trabalho em background. */
async function waitFor(id, expected) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/migrations/${id}`);
    const migration = await res.json();
    if (migration.status !== last) {
      console.log(`  status: ${migration.status}`);
      last = migration.status;
    }
    if (migration.status === expected || migration.status === 'FAILED') return migration;
    await sleep(POLL_MS);
  }
  throw new Error(`tempo esgotado esperando ${expected} (último status: ${last})`);
}

async function printEvents(id) {
  const { data } = await call('GET', `/migrations/${id}/events`);
  for (const e of data) {
    const transition = e.fromStatus ? `${e.fromStatus} → ${e.toStatus}` : (e.toStatus ?? '');
    console.log(`  ${e.createdAt}  ${e.type.padEnd(20)} ${transition}`);
  }
}

const DECIDED_BY = { rule: 'regra', ai: 'IA', human: 'humano' };

function printProposal(proposal) {
  console.log(`\nProposta: ${proposal.summary}`);
  for (const c of proposal.conflicts) {
    const who = c.status === 'DEFERRED' ? 'DEFER' : DECIDED_BY[c.decidedBy];
    console.log(`  [${who.padEnd(6)}] ${c.id.padEnd(22)} ${c.sourceType} → ${c.targetType}`);
    console.log(`           ${c.status === 'DEFERRED' ? `pendente: ${c.deferReason}` : c.resolution}`);
  }
}

function fail(migration) {
  console.log(`\nMigração terminou em FAILED: ${migration.error}`);
  process.exitCode = 1;
}

async function main() {
  if (!MODES.includes(mode)) {
    throw new Error(`modo desconhecido: ${mode} (use ${MODES.join(', ')})`);
  }

  const created = await call('POST', '/migrations', {
    name: 'ERP legado',
    source: { type: 'mysql', host: 'erp-db.local', database: 'erp', user: 'demo', password: 'senha-ficticia' },
    target: { type: 'oracle' },
  });
  if (created.status !== 201) throw new Error(`não foi possível criar a migração: ${JSON.stringify(created.data)}`);
  const id = created.data.id;
  console.log(`  id: ${id}`);

  if (mode === 'invalid') {
    const res = await call('POST', `/migrations/${id}/execute`);
    console.log(`  ${res.data?.error}`);
    return;
  }

  await call('POST', `/migrations/${id}/analyze`);
  const analyzed = await waitFor(id, 'WAITING_APPROVAL');
  if (analyzed.status === 'FAILED') {
    fail(analyzed);
    return printEvents(id);
  }
  printProposal(analyzed.proposal);

  if (mode === 'reject') {
    const rejected = await call('POST', `/migrations/${id}/reject`, { reason: 'Mapeamento de pedidos incorreto' });
    console.log(`  status: ${rejected.data.status}`);
    return printEvents(id);
  }

  if (mode === 'deferred') {
    const res = await call('POST', `/migrations/${id}/approve`);
    console.log(`  ${res.data?.error}`);
    return;
  }

  // O que a IA devolveu como DEFER só segue com uma decisão humana.
  const decisions = analyzed.proposal.conflicts
    .filter((c) => c.status === 'DEFERRED')
    .map((c) => ({ conflictId: c.id, resolution: 'Converter para NULL e registrar no relatório (decisão do DBA)' }));
  const approved = await call('POST', `/migrations/${id}/approve`, { decisions });
  if (approved.status !== 200) throw new Error(`aprovação recusada: ${approved.data?.error}`);
  for (const d of decisions) console.log(`  decisão humana em ${d.conflictId}: ${d.resolution}`);

  await call('POST', `/migrations/${id}/execute`);
  const executed = await waitFor(id, 'COMPLETED');
  if (executed.status === 'FAILED') {
    fail(executed);
  } else {
    const { sandbox, validation, apply } = executed.result;
    console.log(`\nSandbox ${sandbox.datasetId}: fidelidade ${sandbox.fidelity}`);
    for (const t of sandbox.tables) {
      console.log(`  ${t.name}: ${t.rows} linhas, anonimizadas: ${t.anonymizedColumns.join(', ') || 'nenhuma'}`);
    }
    console.log('Validação no sandbox:');
    for (const check of validation.checks) console.log(`  ${check.passed ? 'ok   ' : 'FALHA'} ${check.name}`);
    console.log(`Destino: ${apply.tablesMigrated} tabelas, ${apply.rowsMigrated} linhas migradas`);
  }
  await printEvents(id);
}

main().catch((err) => {
  const refused = err.cause?.code === 'ECONNREFUSED';
  console.error(refused ? `Backend fora do ar em ${BASE}. Rode: docker compose up --build` : `Erro: ${err.message}`);
  process.exitCode = 1;
});
