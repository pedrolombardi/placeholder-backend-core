import { TOKEN_TTL, authEnabled } from './auth';
import { AI_LAYER_URL, DATA_LAYER_URL, DB_LAYER_URL, dbLayerHealth, HealthProbe, probeHealth } from './clients';
import * as repo from './repository';
import type { Connection } from './repository';
import type { CreateConnectionInput, DbHealth } from './schemas';
import { HttpError } from './service';

/**
 * Conexões: o cadastro (`saved`) é informativo, sem senha. O DB Layer só serve a
 * conexão configurada nele, então "testar" uma conexão salva é conferir se ela
 * descreve a conexão viva do DB Layer para aquele papel e se essa conexão está de pé.
 */

type Side = 'source' | 'target';
type LiveSide = DbHealth['source'];

const SIDE_LABEL: Record<Side, string> = { source: 'origem', target: 'destino' };

/** Motivo de um lado fora do ar, como o DB Layer o descreveu. */
const sideError = (side: LiveSide) => (typeof side.error === 'string' ? side.error : 'desconectado');

const unreachable = (probe: HealthProbe) => `DB Layer indisponível (${DB_LAYER_URL}): ${probe.detail ?? 'resposta fora do contrato'}`;

function degraded(health: DbHealth): string {
  const down = (['source', 'target'] as const)
    .filter((s) => !health[s].connected)
    .map((s) => `${SIDE_LABEL[s]}: ${sideError(health[s])}`);
  return `DB Layer sem conexão com ${down.join('; ') || 'um dos bancos'}`;
}

export async function liveConnections() {
  const { probe, health } = await dbLayerHealth();
  if (!health) {
    return { status: 'error' as const, source: null, target: null, error: unreachable(probe) };
  }
  if (health.status === 'ok') return { status: 'ok' as const, source: health.source, target: health.target };
  return { status: 'error' as const, source: health.source, target: health.target, error: degraded(health) };
}

export async function listConnections() {
  const [live, saved] = await Promise.all([liveConnections(), repo.listConnections()]);
  return { live, saved };
}

export const createConnection = (input: CreateConnectionInput, actor: string): Promise<Connection> =>
  repo.insertConnection({
    name: input.name,
    role: input.role,
    engine: input.engine,
    host: input.host,
    port: input.port ?? null,
    database: input.database,
    username: input.username ?? null,
    createdBy: actor,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findConnection(id: string): Promise<Connection> {
  const connection = UUID.test(id) ? await repo.findConnection(id) : null;
  if (!connection) throw new HttpError(404, 'Conexão não encontrada');
  return connection;
}

export async function deleteConnection(id: string): Promise<void> {
  if (!UUID.test(id) || !(await repo.deleteConnection(id))) throw new HttpError(404, 'Conexão não encontrada');
}

export interface ConnectionTest {
  ok: boolean;
  detail: string;
  latencyMs: number | null;
}

export async function testConnection(id: string): Promise<ConnectionTest> {
  const saved = await findConnection(id);
  const { probe, health } = await dbLayerHealth();
  if (!health) return { ok: false, detail: unreachable(probe), latencyMs: null };

  const live = health[saved.role];
  const label = SIDE_LABEL[saved.role];
  const latencyMs = typeof live.latencyMs === 'number' ? live.latencyMs : null;
  const mismatches = [
    typeof live.engine === 'string' && live.engine !== saved.engine && `motor ${live.engine}, não ${saved.engine}`,
    typeof live.schema === 'string' &&
      live.schema.toLowerCase() !== saved.database.toLowerCase() &&
      `database ${live.schema}, não ${saved.database}`,
  ].filter(Boolean);
  if (mismatches.length > 0) {
    return {
      ok: false,
      detail: `A conexão de ${label} configurada no DB Layer usa ${mismatches.join(' e ')}: o DB Layer só serve a conexão configurada nele`,
      latencyMs,
    };
  }
  if (!live.connected) {
    return { ok: false, detail: `A conexão de ${label} do DB Layer está fora do ar: ${sideError(live)}`, latencyMs: null };
  }
  return {
    ok: true,
    detail:
      `Conexão de ${label} do DB Layer ativa (${String(live.engine)} ${String(live.version ?? '')}, database ${String(live.schema)}); ` +
      'host, porta e usuário não são comparados porque o DB Layer não os expõe',
    latencyMs,
  };
}

// ---- Configurações ----

export interface LayerStatus {
  url: string;
  healthy: boolean;
  detail: string | null;
  latencyMs: number | null;
}

const layerStatus = (url: string, probe: HealthProbe, detail = probe.detail): LayerStatus => ({
  url,
  healthy: probe.healthy,
  detail,
  latencyMs: probe.latencyMs,
});

async function dbLayerStatus(): Promise<LayerStatus> {
  const { probe, health } = await dbLayerHealth();
  if (probe.healthy || !health) return layerStatus(DB_LAYER_URL, probe);
  return layerStatus(DB_LAYER_URL, probe, degraded(health));
}

export async function settings() {
  const [db, ai, data] = await Promise.all([
    dbLayerStatus(),
    probeHealth(`${AI_LAYER_URL}/health`).then((p) => layerStatus(AI_LAYER_URL, p)),
    probeHealth(`${DATA_LAYER_URL}/health`).then((p) => layerStatus(DATA_LAYER_URL, p)),
  ]);
  return { authEnabled: authEnabled(), tokenTtl: TOKEN_TTL, layers: { db, ai, data } };
}
