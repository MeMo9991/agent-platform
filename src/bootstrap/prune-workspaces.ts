import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SqliteStore } from '../storage/sqlite/store.js';

const activeRunStatuses = new Set(['queued', 'running', 'waiting_human', 'paused']);
const terminalTaskStates = new Set(['closed', 'cancelled', 'released']);
const safeRunId = /^[A-Za-z0-9_-]+$/;
const DAY = 24 * 60 * 60 * 1000;

interface RunRow { taskId: string; status: string; createdAt: string; endedAt?: string }
interface TaskRow { state: string; updatedAt: string }

export interface PruneWorkspacesResult {
  clonesDeleted: number;
  checkWorkspacesDeleted: number;
  kept: number;
  errors: number;
}

export async function pruneWorkspaces(input: {
  store: SqliteStore;
  runtimeRoot: string;
  now?: Date;
  retentionMs?: number;
  orphanGraceMs?: number;
  dryRun?: boolean;
  onError?: (path: string, error: unknown) => void;
}): Promise<PruneWorkspacesResult> {
  const now = (input.now ?? new Date()).getTime();
  const retentionMs = input.retentionMs ?? 7 * DAY;
  const orphanGraceMs = input.orphanGraceMs ?? DAY;
  const runtimeRoot = resolve(input.runtimeRoot);
  const runs = new Map<string, RunRow>();
  for (const row of input.store.db.prepare('SELECT id,task_id,status,created_at,ended_at FROM run').all()) {
    runs.set(String(row.id), { taskId: String(row.task_id), status: String(row.status),
      createdAt: String(row.created_at), ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}) });
  }
  const tasks = new Map<string, TaskRow>();
  for (const row of input.store.db.prepare('SELECT id,state,updated_at FROM task').all())
    tasks.set(String(row.id), { state: String(row.state), updatedAt: String(row.updated_at) });
  const activeTaskIds = new Set<string>();
  for (const run of runs.values()) if (activeRunStatuses.has(run.status)) activeTaskIds.add(run.taskId);
  const pendingEffectTaskIds = new Set<string>();
  for (const row of input.store.db.prepare(`SELECT DISTINCT task_id FROM task_record
    WHERE kind='effect' AND status IN ('pending','uncertain')`).all())
    pendingEffectTaskIds.add(String(row.task_id));

  const result: PruneWorkspacesResult = { clonesDeleted: 0, checkWorkspacesDeleted: 0, kept: 0, errors: 0 };

  async function removeIfSafe(directory: string, name: string): Promise<boolean> {
    if (!safeRunId.test(name)) { result.kept++; return false; }
    const path = resolve(directory, name);
    if (!path.startsWith(`${directory}/`)) { result.kept++; return false; }
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) { result.kept++; return false; }
      const canonical = await realpath(path);
      if (!canonical.startsWith(`${await realpath(directory)}/`)) { result.kept++; return false; }
      if (!input.dryRun) await rm(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      result.errors++;
      input.onError?.(path, error);
      return false;
    }
  }

  async function directoryAge(path: string): Promise<number | undefined> {
    try { return now - (await lstat(path)).mtimeMs; }
    catch { return undefined; }
  }

  for (const kind of ['clones', 'check-workspaces'] as const) {
    const directory = resolve(runtimeRoot, kind);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.errors++;
        input.onError?.(directory, error);
      }
      continue;
    }
    for (const name of names) {
      const run = runs.get(name);
      if (!run) {
        const age = await directoryAge(resolve(directory, name));
        if (age !== undefined && age >= orphanGraceMs && await removeIfSafe(directory, name))
          kind === 'clones' ? result.clonesDeleted++ : result.checkWorkspacesDeleted++;
        else result.kept++;
        continue;
      }
      const task = tasks.get(run.taskId);
      if (kind === 'check-workspaces') {
        // Check copies are only needed while their Run is active. A terminal Run's
        // leftover copy is safe to remove after the short orphan grace.
        if (activeRunStatuses.has(run.status)) { result.kept++; continue; }
        const age = await directoryAge(resolve(directory, name));
        if (age !== undefined && age >= orphanGraceMs && await removeIfSafe(directory, name))
          result.checkWorkspacesDeleted++;
        else result.kept++;
        continue;
      }
      if (!task || !terminalTaskStates.has(task.state) || activeTaskIds.has(run.taskId) ||
        pendingEffectTaskIds.has(run.taskId)) {
        result.kept++;
        continue;
      }
      const basis = Math.max(Date.parse(task.updatedAt), Date.parse(run.endedAt ?? run.createdAt));
      if (Number.isFinite(basis) && now - basis >= retentionMs && await removeIfSafe(directory, name))
        result.clonesDeleted++;
      else result.kept++;
    }
  }
  return result;
}
