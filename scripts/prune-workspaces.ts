import { loadConfiguration } from '../src/bootstrap/config/load.js';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { pruneWorkspaces } from '../src/bootstrap/runtime/prune-workspaces.js';

const dryRun = process.argv.includes('--dry-run');
const { database, runtimeRoot, workspaceRetentionMs, workspaceOrphanGraceMs } = loadConfiguration(process.cwd());
const store = new SqliteStore(database);
try {
  const result = await pruneWorkspaces({ store, runtimeRoot, dryRun,
    retentionMs: workspaceRetentionMs, orphanGraceMs: workspaceOrphanGraceMs,
    onError: (path, error) => console.error(`Failed to prune ${path}`, error) });
  console.log(JSON.stringify({ dryRun, database, runtimeRoot, ...result }, null, 2));
} finally {
  store.close();
}
