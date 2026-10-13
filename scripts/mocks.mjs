/**
 * Recria o container dos mocks num modo de falha. Funciona em Windows, Linux e Mac
 * (a forma `FAIL=ai docker compose ...` nao funciona no PowerShell nem no cmd).
 *
 *   node scripts/mocks.mjs ai|db|data|validation|ok
 */
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] ?? 'ok';
const env = { ...process.env, FAIL: '', VALIDATION_FAIL: 'false' };
if (['ai', 'db', 'data'].includes(mode)) env.FAIL = mode;
else if (mode === 'validation') env.VALIDATION_FAIL = 'true';
else if (mode !== 'ok') {
  console.error(`modo desconhecido: ${mode} (use ai, db, data, validation ou ok)`);
  process.exit(1);
}

const r = spawnSync('docker', ['compose', 'up', '-d', 'mocks'], { env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
