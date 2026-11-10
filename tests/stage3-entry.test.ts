import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';

const root = resolve(import.meta.dirname, '..');

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolveExit => child.once('exit', resolveExit));
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitForExit(child);
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => rejectReady(new Error(`Service startup timed out: ${stderr}`)), 10_000);
    const done = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onError);
      child.off('exit', onExit);
      if (error) rejectReady(error); else resolveReady();
    };
    const onOutput = (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes('Agent platform ready')) done();
    };
    const onError = (data: Buffer) => { stderr += data.toString(); };
    const onExit = (code: number | null) => done(new Error(`Service exited before ready (${code}): ${stderr}`));
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onError);
    child.once('exit', onExit);
  });
}

test('formal entry rejects a second process before database recovery and releases the lock on exit or startup failure',
  { timeout: 30_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-platform-entry-'));
    const state = join(directory, 'state');
    mkdirSync(state, { mode: 0o700 });
    const database = join(state, 'platform.sqlite3');
    const config = join(directory, 'platform.json');
    const schedules = join(directory, 'schedules.json');
    const provider = join(directory, 'auth.mjs');
    writeFileSync(config, JSON.stringify({ repositories: [], sources: [], agents: [{ kind: 'qoder', enabled: false }],
      budget: { maxRunMs: 60_000, maxConcurrentRuns: 2, perRepoConcurrentRuns: 2,
        perAgentConcurrentRuns: 2, reservedHumanResume: 1 }, policyRef: 'test-policy' }));
    writeFileSync(schedules, JSON.stringify({ tasks: [] }));
    writeFileSync(provider, 'export async function authorizationHeaders() { return {}; }\n');
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    const env = { ...process.env, AGENT_PLATFORM_CONFIG: config, AGENT_PLATFORM_SCHEDULES: schedules,
      AGENT_PLATFORM_DATABASE: database, AGENT_PLATFORM_AUTH_PROVIDER: provider };
    const launch = (auth = provider) => spawn(process.execPath, ['dist/bootstrap/main.js'], {
      cwd: root, env: { ...env, AGENT_PLATFORM_AUTH_PROVIDER: auth }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let first: ChildProcess | undefined;
    let third: ChildProcess | undefined;
    try {
      first = launch();
      await waitForReady(first);
      const store = new SqliteStore(database);
      const at = new Date().toISOString();
      try {
        store.saveTask({ id: 'lock-task', repoKey: 'test-repo', title: 'Keep this Task unchanged',
          scope: 'investigate', mandate: { sourceEventId: 'test-event', repoKey: 'test-repo', goal: 'investigate',
            allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'test-policy',
            authority: { kind: 'trusted_rule', ruleRef: 'test' } },
          state: 'investigating', iteration: 1, priority: 1, createdAt: at, updatedAt: at });
        store.saveRun({ id: 'lock-run', taskId: 'lock-task', iteration: 1, stage: 'investigate',
          status: 'running', priority: 1, attempt: 1, agentKind: 'qoder', sessionId: 'old-session',
          workerId: 'old-worker', leaseUntil: '2099-01-01T00:00:00.000Z', createdAt: at, startedAt: at });
      } finally { store.close(); }
      const second = launch();
      let secondError = '';
      second.stderr?.on('data', chunk => { secondError += String(chunk); });
      assert.notEqual(await waitForExit(second), 0);
      assert.match(secondError, /Instance lock unavailable/);
      const unchanged = new SqliteStore(database);
      try {
        assert.equal(unchanged.getTask('lock-task')?.state, 'investigating');
        assert.equal(unchanged.getRun('lock-run')?.status, 'running');
        assert.equal(unchanged.getRun('lock-run')?.processTerminationUnconfirmed, undefined);
      } finally { unchanged.close(); }
      await stop(first);
      const failed = launch(join(directory, 'missing-provider.mjs'));
      assert.notEqual(await waitForExit(failed), 0);
      third = launch();
      await waitForReady(third);
      const recovered = new SqliteStore(database);
      try {
        assert.equal(recovered.getRun('lock-run')?.status, 'paused');
        assert.equal(recovered.getRun('lock-run')?.processTerminationUnconfirmed, true);
      } finally { recovered.close(); }
    } finally {
      await stop(third);
      await stop(first);
      rmSync(directory, { recursive: true, force: true });
    }
  });
