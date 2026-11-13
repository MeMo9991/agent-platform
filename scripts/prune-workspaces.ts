import { resolve } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { pruneWorkspaces } from '../src/bootstrap/prune-workspaces.js';

const dryRun = process.argv.includes('--dry-run');
const database = resolve(process.env.AGENT_PLATFORM_DATABASE ?? '.runtime/state/agent-platform.sqlite3');
const runtimeRoot = resolve(process.env.AGENT_PLATFORM_RUNTIME_ROOT ?? '.runtime');
const retentionDays = Number(process.env.AGENT_PLATFORM_WORKSPACE_RETENTION_DAYS ?? '7');
const orphanHours = Number(process.env.AGENT_PLATFORM_WORKSPACE_ORPHAN_HOURS ?? '24');
const store = new SqliteStore(database);
try {
  const result = await pruneWorkspaces({ store, runtimeRoot, dryRun,
    retentionMs: (Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : 7) * 86_400_000,
    orphanGraceMs: (Number.isFinite(orphanHours) && orphanHours >= 0 ? orphanHours : 24) * 3_600_000,
    onError: (path, error) => console.error(`Failed to prune ${path}`, error) });
  console.log(JSON.stringify({ dryRun, database, runtimeRoot, ...result }, null, 2));
} finally {
  store.close();
}
