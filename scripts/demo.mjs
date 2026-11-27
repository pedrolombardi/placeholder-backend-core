/**
 * Roda o roteiro do requests.http contra o backend.
 * Uso: node scripts/demo.mjs [approve|reject|invalid|deferred|rbac|metrics]
 *   approve (padrão): fluxo completo até COMPLETED, decidindo os conflitos que a IA devolveu como DEFER
 *   reject:           rejeita a proposta e termina em REJECTED
 *   invalid:          tenta executar sem aprovação e mostra o 409
 *   deferred:         tenta aprovar sem decidir os DEFER e mostra o 422
 *   rbac:             o usuário DEV_QA cria e analisa, recebe 403 ao aprovar; o DBA aprova e executa
 *   metrics:          só imprime o GET /metrics
 *
 * Com AUTH_ENABLED=true no backend, o roteiro faz login (DBA: DEMO_DBA_USER/DEMO_DBA_PASSWORD,
 * DEV_QA: DEMO_QA_USER/DEMO_QA_PASSWORD; padrão dba/dba123 e qa/qa123).
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const mode = process.argv[2] ?? 'approve';
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const MODES = ['approve', 'reject', 'invalid', 'deferred', 'rbac', 'metrics'];
const DBA = { username: process.env.DEMO_DBA_USER ?? 'dba', password: process.env.DEMO_DBA_PASSWORD ?? 'dba123' };
const QA = { username: process.env.DEMO_QA_USER ?? 'qa', password: process.env.DEMO_QA_PASSWORD ?? 'qa123' };

/** Token do usuário atual (null com a auth desligada). */
let token = null;
let authEnabled = false;
const authHeaders = () => (token ? { authorization: `Bearer ${token}` } : {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...authHeaders() },
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
    const res = await fetch(`${BASE}/migrations/${id}`, { headers: authHeaders() });
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
    console.log(`  ${e.createdAt}  ${(e.actor ?? '-').padEnd(10)} ${e.type.padEnd(20)} ${transition}`);
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

/** Faz login quando o backend exige autenticação; com a auth desligada, segue sem token. */
async function loginAs(user) {
  if (!authEnabled) return;
  const res = await call('POST', '/auth/login', user);
  if (res.status !== 200) throw new Error(`login de ${user.username} recusado: ${res.data?.error}`);
  token = res.data.token;
  console.log(`  logado como ${res.data.user.username} (${res.data.user.role})`);
}

const seconds = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)} s`);

async function printMetrics() {
  const { status, data } = await call('GET', '/metrics');
  if (status !== 200) return console.log(`  ${data?.error}`);
  const { migrations, conflicts, stageDurations, failuresByStage } = data;
  const rate = migrations.successRate == null ? '-' : `${(migrations.successRate * 100).toFixed(0)}%`;
  console.log(`  migrações: ${migrations.total} (taxa de sucesso ${rate}, aguardando homologação ${migrations.waitingApproval})`);
  const statuses = Object.entries(migrations.byStatus).filter(([, n]) => n > 0);
  console.log(`  por status: ${statuses.map(([s, n]) => `${s}=${n}`).join(', ') || 'nenhuma'}`);
  const by = conflicts.byDecidedBy;
  console.log(`  conflitos: ${conflicts.total} (regra ${by.rule}, IA ${by.ai}, humano ${by.human}, pendentes ${conflicts.pendingHuman})`);
  console.log('  duração média por etapa:');
  for (const [stage, d] of Object.entries(stageDurations)) console.log(`    ${stage.padEnd(11)} ${seconds(d.avgMs).padStart(8)}  (${d.count})`);
  const failures = Object.entries(failuresByStage);
  if (failures.length) console.log(`  falhas por etapa: ${failures.map(([s, n]) => `${s}=${n}`).join(', ')}`);
}

function fail(migration) {
  console.log(`\nMigração terminou em FAILED: ${migration.error}`);
  process.exitCode = 1;
}

async function main() {
  if (!MODES.includes(mode)) {
    throw new Error(`modo desconhecido: ${mode} (use ${MODES.join(', ')})`);
  }

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  authEnabled = health.auth === true;
  console.log(`Backend ${BASE}: autenticação ${authEnabled ? 'ligada' : 'desligada'}`);
  // No modo rbac quem cria e analisa é o DEV_QA; nos demais, o DBA faz tudo.
  await loginAs(mode === 'rbac' ? QA : DBA);

  if (mode === 'metrics') return printMetrics();

  const created = await call('POST', '/migrations', {
    name: 'ERP legado',
    // Com o DB Layer real, o banco precisa ser o configurado nele: SOURCE_DATABASE=vendas.
    source: { type: 'mysql', host: 'erp-db.local', database: process.env.SOURCE_DATABASE ?? 'erp', user: 'demo', password: 'senha-ficticia' },
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

  if (mode === 'rbac') {
    const res = await call('POST', `/migrations/${id}/approve`, { decisions: [] });
    console.log(`  ${res.data?.error}`);
    if (authEnabled && res.status !== 403) throw new Error(`esperava 403 para o DEV_QA, veio ${res.status}`);
    console.log('\nHomologação é do DBA:');
    await loginAs(DBA);
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
  await printMetrics();
}

main().catch((err) => {
  const refused = err.cause?.code === 'ECONNREFUSED';
  console.error(refused ? `Backend fora do ar em ${BASE}. Rode: docker compose up --build` : `Erro: ${err.message}`);
  process.exitCode = 1;
});
