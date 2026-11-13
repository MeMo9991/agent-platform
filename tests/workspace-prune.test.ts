import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { pruneWorkspaces } from '../src/bootstrap/prune-workspaces.js';
import type { Task } from '../src/agent/task/model.js';
import type { Run } from '../src/agent/worker/model.js';

function task(id: string, state: Task['state'], at: string): Task {
  return { id, repoKey: 'repo', title: id, scope: id,
    mandate: { sourceEventId: `event-${id}`, repoKey: 'repo', goal: id,
      allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'trusted_rule', ruleRef: 'test' } },
    state, iteration: 1, priority: 0, createdAt: at, updatedAt: at };
}

function run(id: string, taskId: string, status: Run['status'], at: string, workspace: string): Run {
  return { id, taskId, iteration: 1, stage: 'develop', status, priority: 0, attempt: 1,
    workspaceRef: workspace, createdAt: at, ...(status === 'running' ? {} : { endedAt: at }) };
}

test('prune deletes only old terminal clones and orphaned workspaces', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-workspace-prune-'));
  const store = new SqliteStore(':memory:', { fixture: [] });
  const old = '2020-01-01T00:00:00.000Z';
  const now = new Date('2026-01-01T00:00:00.000Z');
  try {
    const runtimeRoot = join(directory, 'runtime');
    for (const name of ['run-terminal', 'run-active', 'orphan-old', 'orphan-new'])
      mkdirSync(join(runtimeRoot, 'clones', name), { recursive: true });
    for (const name of ['run-check-terminal', 'run-check-running'])
      mkdirSync(join(runtimeRoot, 'check-workspaces', name), { recursive: true });
    writeFileSync(join(runtimeRoot, 'clones', 'run-terminal', 'file'), 'x');
    writeFileSync(join(runtimeRoot, 'clones', 'run-active', 'file'), 'x');
    writeFileSync(join(runtimeRoot, 'clones', 'orphan-old', 'file'), 'x');
    writeFileSync(join(runtimeRoot, 'clones', 'orphan-new', 'file'), 'x');
    writeFileSync(join(runtimeRoot, 'check-workspaces', 'run-check-terminal', 'file'), 'x');
    writeFileSync(join(runtimeRoot, 'check-workspaces', 'run-check-running', 'file'), 'x');
    for (const path of ['clones/run-terminal', 'clones/run-active', 'clones/orphan-old',
      'check-workspaces/run-check-terminal'])
      utimesSync(join(runtimeRoot, path), new Date(old), new Date(old));
    const terminal = task('task-terminal', 'closed', old);
    const active = task('task-active', 'reviewing', old);
    store.saveTask(terminal);
    store.saveTask(active);
    store.saveRun(run('run-terminal', terminal.id, 'succeeded', old,
      join(runtimeRoot, 'clones', 'run-terminal')));
    store.saveRun(run('run-active', active.id, 'succeeded', old,
      join(runtimeRoot, 'clones', 'run-active')));
    store.saveRun(run('run-check-terminal', terminal.id, 'succeeded', old,
      join(runtimeRoot, 'check-workspaces', 'run-check-terminal')));
    store.saveRun(run('run-check-running', active.id, 'running', old,
      join(runtimeRoot, 'check-workspaces', 'run-check-running')));
    const result = await pruneWorkspaces({ store, runtimeRoot, now,
      retentionMs: 7 * 86_400_000, orphanGraceMs: 86_400_000 });
    assert.equal(result.clonesDeleted, 2);
    assert.equal(result.checkWorkspacesDeleted, 1);
    assert.equal(existsSync(join(runtimeRoot, 'clones', 'run-terminal')), false);
    assert.equal(existsSync(join(runtimeRoot, 'clones', 'run-active')), true);
    assert.equal(existsSync(join(runtimeRoot, 'clones', 'orphan-old')), false);
    assert.equal(existsSync(join(runtimeRoot, 'clones', 'orphan-new')), true);
    assert.equal(existsSync(join(runtimeRoot, 'check-workspaces', 'run-check-terminal')), false);
    assert.equal(existsSync(join(runtimeRoot, 'check-workspaces', 'run-check-running')), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prune keeps terminal clones until the retention window passes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-workspace-prune-retain-'));
  const store = new SqliteStore(':memory:', { fixture: [] });
  const old = '2020-01-01T00:00:00.000Z';
  try {
    const runtimeRoot = join(directory, 'runtime');
    mkdirSync(join(runtimeRoot, 'clones', 'run-terminal'), { recursive: true });
    const terminal = task('task-terminal', 'closed', old);
    store.saveTask(terminal);
    store.saveRun(run('run-terminal', terminal.id, 'succeeded', old,
      join(runtimeRoot, 'clones', 'run-terminal')));
    const result = await pruneWorkspaces({ store, runtimeRoot, now: new Date('2020-01-02T00:00:00.000Z'),
      retentionMs: 7 * 86_400_000, orphanGraceMs: 86_400_000 });
    assert.equal(result.clonesDeleted, 0);
    assert.equal(existsSync(join(runtimeRoot, 'clones', 'run-terminal')), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
