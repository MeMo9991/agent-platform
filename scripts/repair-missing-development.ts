import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { acquireInstanceLock } from '../src/bootstrap/instance-lock.js';

const taskId = (() => {
  const index = process.argv.indexOf('--task');
  return index >= 0 ? process.argv[index + 1] : undefined;
})();
const apply = process.argv.includes('--apply');
if (!taskId) throw new Error('Usage: repair-missing-development.ts --task <taskId> [--apply]');
const database = resolve(process.env.AGENT_PLATFORM_DATABASE ?? '.runtime/state/agent-platform.sqlite3');
const runtimeRoot = resolve(process.env.AGENT_PLATFORM_RUNTIME_ROOT ?? '.runtime');
const lock = apply ? await acquireInstanceLock(database, () => {}) : undefined;
const store = new SqliteStore(database);
try {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} is missing`);
  const runRow = store.db.prepare(`SELECT id FROM run WHERE task_id=? AND stage='develop' AND status='succeeded'
    AND commit_sha IS NOT NULL ORDER BY ended_at DESC LIMIT 1`).get(taskId);
  const run = runRow ? store.getRun(String(runRow.id)) : undefined;
  if (!run || !run.commitSha || !run.workspaceRef || !task.baseRef)
    throw new Error('Task has no usable successful development Run with base and commit SHAs');
  const existing = store.db.prepare(`SELECT id FROM task_record WHERE task_id=? AND kind='development'
    AND json_extract(payload_json,'$.commitSha')=? AND json_extract(payload_json,'$.postCheckVerified')=1`)
    .get(taskId, run.commitSha);
  if (existing) {
    console.log(JSON.stringify({ taskId, commitSha: run.commitSha, result: 'already-present' }));
  } else {
    const git = (...args: string[]) => execFileSync('git', ['-C', run.workspaceRef!, ...args],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
    if (git('rev-parse', 'HEAD') !== run.commitSha) throw new Error('Development clone HEAD changed');
    if (git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Development clone is not clean');
    try { execFileSync('git', ['-C', run.workspaceRef, 'merge-base', '--is-ancestor', task.baseRef, run.commitSha]); }
    catch { throw new Error('Development commit is not based on the Task base'); }
    const diff = execFileSync('git', ['-C', run.workspaceRef, 'diff', '--binary', task.baseRef, run.commitSha],
      { maxBuffer: 10 * 1024 * 1024 });
    if (!diff.length || diff.length > 2 * 1024 * 1024) throw new Error('Development diff is empty or too large');
    const evidenceDir = resolve(runtimeRoot, 'evidence');
    const diffRef = resolve(evidenceDir, `recovered-${randomUUID()}.patch`);
    const verifyRow = store.db.prepare(`SELECT id FROM run WHERE task_id=? AND stage='verify'
      AND status='paused' AND commit_sha=? ORDER BY created_at DESC LIMIT 1`).get(taskId, run.commitSha);
    const verify = verifyRow ? store.getRun(String(verifyRow.id)) : undefined;
    const plan = { taskId, developRunId: run.id, commitSha: run.commitSha, baseSha: task.baseRef,
      diffBytes: diff.length, diffRef, verifyRunId: verify?.id, taskState: task.state, apply };
    if (apply) {
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      await writeFile(diffRef, diff, { mode: 0o600, flag: 'wx' });
      store.transaction(() => {
        store.saveRecord({ id: randomUUID(), taskId, runId: run.id, kind: 'development',
          baseSha: task.baseRef!, commitSha: run.commitSha!, diffRef, postCheckVerified: true,
          at: new Date().toISOString() });
        if (verify) {
          store.replaceRun({ ...verify, status: 'queued', workerId: undefined, leaseUntil: undefined,
            startedAt: undefined, endedAt: undefined, attempt: 0, sessionId: undefined, workspaceRef: undefined,
            checkWorkspaceRef: undefined, cacheKey: undefined, execution: undefined,
            processTerminationUnconfirmed: false }, 'paused');
        } else {
          store.saveRun({ id: randomUUID(), taskId, iteration: task.iteration, stage: 'verify',
            status: 'queued', priority: task.priority, attempt: 0, agentKind: 'qoder',
            commitSha: run.commitSha, createdAt: new Date().toISOString() });
        }
        const actor = { kind: 'system' as const, id: 'repair-missing-development' };
        const at = new Date().toISOString();
        if (task.state === 'blocked' || task.state === 'failed') {
          store.saveTransition(taskId, 'queued', 'Repair missing development evidence', at, randomUUID(), actor);
          store.saveTransition(taskId, 'verifying', 'Repair missing development evidence', at, randomUUID(), actor);
        } else if (task.state === 'waiting_human' || task.state === 'paused') {
          store.saveTransition(taskId, 'verifying', 'Repair missing development evidence', at, randomUUID(), actor);
        } else if (task.state !== 'verifying') {
          throw new Error(`Task state ${task.state} cannot be repaired`);
        }
      });
    }
    console.log(JSON.stringify(plan, null, 2));
  }
} finally {
  store.close();
  await lock?.release();
}
