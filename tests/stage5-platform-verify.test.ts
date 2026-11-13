import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createWorkerManager } from '../src/agent/worker/manager.js';
import { createKernelCoordinator } from './kernel-fixture.js';
import type { Task } from '../src/agent/task/model.js';
import type { Run } from '../src/agent/worker/model.js';

function createTask(at: string, commitSha: string): Task {
  return { id: 'task-1', repoKey: 'agent-platform', title: 'Task', scope: 'Task',
    mandate: { sourceEventId: 'event-1', repoKey: 'agent-platform', goal: 'Task',
      allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'trusted_rule', ruleRef: 'test' } },
    state: 'verifying', iteration: 1, priority: 0, baseRef: commitSha, createdAt: at, updatedAt: at };
}

function createManager(store: SqliteStore, coordinator: ReturnType<typeof createKernelCoordinator>,
  paths: { source: string; checkCopy: string; cacheRoot: string; directory: string },
  commitSha: string, state: { runnerStarted: boolean; released: boolean;
    commands: { command: string; cwd: string; env?: Readonly<Record<string, string>> }[] }) {
  return createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
    runners: { qoder: { capabilities: () => ({ start: 'supported' }),
      async start() { state.runnerStarted = true; return { sessionId: 'must-not-start' }; },
      async resume() { return { kind: 'unsupported' as const }; },
      async send() { return { kind: 'unsupported' as const }; },
      async read() { return { kind: 'unknown' as const, runId: 'verify-run' }; },
      async cancel() { return { kind: 'accepted' as const }; } } },
    workspace: {
      async prepare() { return { repoKey: 'agent-platform', path: paths.source, baseSha: commitSha }; },
      async prepareCheckCopy() { mkdirSync(paths.checkCopy, { recursive: true });
        return { path: paths.checkCopy, baseSha: commitSha }; },
      async cleanupCheckCopy() { rmSync(paths.checkCopy, { recursive: true, force: true }); },
      async verifyAfterChecks(input, expected) {
        assert.equal(input.checkWorkspaceRef, paths.checkCopy);
        assert.equal(expected, commitSha);
      },
    },
    skills: { async load(ref) { return { ref, content: 'verify' }; } },
    boundary: {
      async attest(value) {
        assert.equal(value.mode, 'read');
        assert.equal(value.agentRequired, false);
        assert.equal(value.checkWorkspacePath, paths.checkCopy);
        assert.equal(value.cachePaths?.length, 1);
        return { verified: true as const, runId: value.runId, repoKey: value.repoKey,
          workspacePath: value.workspacePath, mode: 'read' as const, adapterVersion: 'test', configDigest: 'digest' };
      },
      runCheck(value) {
        state.commands.push({ command: value.command, cwd: value.cwd, env: value.env });
        const logRef = join(paths.directory, `${value.command}-${state.commands.length}.log`);
        writeFileSync(logRef, 'ok\n');
        return { completion: Promise.resolve({ result: 'passed' as const, exitCode: 0,
          logRef, terminationConfirmed: true }), async terminate() { return { terminated: true, logRef }; } };
      },
      async release() { state.released = true; },
    },
    localChecks: { 'agent-platform': [{ command: 'npm', args: ['test'], timeoutMs: 5000 }] },
    verifyPlans: { 'agent-platform': { mode: 'platform', workspace: 'copy',
      prepare: [{ command: 'npm', args: ['ci'], timeoutMs: 5000 }],
      env: { npm_config_cache: '${CACHE}/npm' }, cacheKeyFiles: ['package-lock.json'] } },
    cacheRoot: paths.cacheRoot, skillRepoPath: 'agent-platform', skillCommitSha: commitSha, maxRunMs: 60_000,
    checkLogDirectory: join(paths.directory, 'logs'), enabledStages: ['verify'],
    limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
}

test('platform verify runs prepare and checks without an Agent session and reuses its cache', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-verify-'));
  const store = new SqliteStore(':memory:', { fixture: [] });
  try {
    const at = new Date().toISOString();
    const commitSha = 'a'.repeat(40);
    const source = join(directory, 'source');
    const checkCopy = join(directory, 'check');
    const cacheRoot = join(directory, 'cache');
    mkdirSync(source);
    writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const task = createTask(at, commitSha);
    store.saveTask(task);
    const run: Run = { id: 'verify-run', taskId: task.id, iteration: 1, stage: 'verify',
      status: 'queued', priority: 0, attempt: 0, agentKind: 'qoder', commitSha, createdAt: at };
    store.saveRun(run);
    const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['agent-platform']);
    const state = { runnerStarted: false, released: false, commands: [] as
      { command: string; cwd: string; env?: Readonly<Record<string, string>> }[] };
    const manager = createManager(store, coordinator, { source, checkCopy, cacheRoot, directory }, commitSha, state);

    assert.equal(await manager.tick(), true);
    const running = store.getRun('verify-run')!;
    assert.equal(running.status, 'running');
    assert.equal(running.sessionId, undefined);
    assert.equal(running.checkWorkspaceRef, checkCopy);
    assert.ok(running.cacheKey);
    assert.equal(state.runnerStarted, false);
    assert.ok(existsSync(join(cacheRoot, 'agent-platform', running.cacheKey!)));

    assert.equal(await manager.poll(), 1);
    assert.equal(store.getRun('verify-run')?.status, 'succeeded');
    assert.equal(store.getTask(task.id)?.state, 'reviewing');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='review'").get()?.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='check'").get()?.n, 2);
    assert.equal(state.commands.length, 2);
    assert.deepEqual(state.commands.map(item => item.command), ['npm', 'npm']);
    assert.equal(state.commands[0]!.cwd, checkCopy);
    assert.equal(state.commands[0]!.env?.npm_config_cache,
      join(realpathSync(cacheRoot), 'agent-platform', running.cacheKey!, 'npm'));
    assert.equal(state.released, true);

    const secondTask = { ...task, id: 'task-2' };
    store.saveTask(secondTask);
    store.saveRun({ id: 'verify-run-2', taskId: secondTask.id, iteration: 1, stage: 'verify',
      status: 'queued', priority: 0, attempt: 0, agentKind: 'qoder', commitSha, createdAt: at });
    assert.equal(await manager.tick(), true);
    assert.equal(store.getRun('verify-run-2')?.cacheKey, running.cacheKey);
    assert.equal(await manager.poll(), 1);

    writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    const thirdTask = { ...task, id: 'task-3' };
    store.saveTask(thirdTask);
    store.saveRun({ id: 'verify-run-3', taskId: thirdTask.id, iteration: 1, stage: 'verify',
      status: 'queued', priority: 0, attempt: 0, agentKind: 'qoder', commitSha, createdAt: at });
    assert.equal(await manager.tick(), true);
    assert.notEqual(store.getRun('verify-run-3')?.cacheKey, running.cacheKey);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('platform verify blocks when a check fails and does not queue review', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-verify-fail-'));
  const store = new SqliteStore(':memory:', { fixture: [] });
  try {
    const at = new Date().toISOString();
    const commitSha = 'b'.repeat(40);
    const source = join(directory, 'source');
    const checkCopy = join(directory, 'check');
    const cacheRoot = join(directory, 'cache');
    mkdirSync(source);
    writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const task = createTask(at, commitSha);
    store.saveTask(task);
    store.saveRun({ id: 'verify-run', taskId: task.id, iteration: 1, stage: 'verify',
      status: 'queued', priority: 0, attempt: 0, agentKind: 'qoder', commitSha, createdAt: at });
    const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['agent-platform']);
    let runnerStarted = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { runnerStarted = true; return { sessionId: 'must-not-start' }; },
        async resume() { return { kind: 'unsupported' as const }; },
        async send() { return { kind: 'unsupported' as const }; },
        async read() { return { kind: 'unknown' as const, runId: 'verify-run' }; },
        async cancel() { return { kind: 'accepted' as const }; } } },
      workspace: {
        async prepare() { return { repoKey: 'agent-platform', path: source, baseSha: commitSha }; },
        async prepareCheckCopy() { mkdirSync(checkCopy, { recursive: true });
          return { path: checkCopy, baseSha: commitSha }; },
        async cleanupCheckCopy() { rmSync(checkCopy, { recursive: true, force: true }); },
        async verifyAfterChecks() { /* the deterministic gate still checks Git state */ },
      },
      skills: { async load(ref) { return { ref, content: 'verify' }; } },
      boundary: {
        async attest(value) { return { verified: true as const, runId: value.runId, repoKey: value.repoKey,
          workspacePath: value.workspacePath, mode: 'read' as const, adapterVersion: 'test', configDigest: 'digest' }; },
        runCheck(value) {
          const logRef = join(directory, `${value.command}-${value.args[0] ?? 'check'}.log`);
          writeFileSync(logRef, 'result\n');
          const passed = value.args[0] === 'ci';
          return { completion: Promise.resolve({ result: passed ? 'passed' as const : 'failed' as const,
            exitCode: passed ? 0 : 1, logRef, terminationConfirmed: true }),
            async terminate() { return { terminated: true, logRef }; } };
        },
        async release() { /* released */ },
      },
      localChecks: { 'agent-platform': [{ command: 'npm', args: ['test'], timeoutMs: 5000 }] },
      verifyPlans: { 'agent-platform': { mode: 'platform', workspace: 'copy',
        prepare: [{ command: 'npm', args: ['ci'], timeoutMs: 5000 }],
        env: {}, cacheKeyFiles: ['package-lock.json'] } },
      cacheRoot, skillRepoPath: 'agent-platform', skillCommitSha: commitSha, maxRunMs: 60_000,
      checkLogDirectory: join(directory, 'logs'), enabledStages: ['verify'],
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(await manager.poll(), 1);
    assert.equal(store.getRun('verify-run')?.status, 'failed');
    assert.equal(store.getTask(task.id)?.state, 'blocked');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='review'").get()?.n, 0);
    assert.equal(runnerStarted, false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
