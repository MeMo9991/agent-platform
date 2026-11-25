import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
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
      AGENT_PLATFORM_DATABASE: database, AGENT_PLATFORM_AUTH_PROVIDER: provider, GIT_DIR: join(root, '.git') };
    const launch = (auth = provider) => spawn(process.execPath, [join(root, 'dist/bootstrap/main.js')], {
      cwd: directory, env: { ...env, AGENT_PLATFORM_AUTH_PROVIDER: auth }, stdio: ['ignore', 'pipe', 'pipe'],
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

test('an unreachable code host disables external delivery without taking down the dashboard', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-host-preflight-'));
  let service: ChildProcess | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>(resolveListening => reservation.listen(0, '127.0.0.1', resolveListening));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()));

    const config = join(directory, 'config');
    mkdirSync(config);
    writeFileSync(join(config, 'local.json'), JSON.stringify({
      capabilities: { stage5Writes: true },
      platform: { interaction: { port, credentialFile: join(directory, 'local.token') },
        repositories: [{ repoKey: 'unreachable-host', provider: 'gitlab', hostUrl: 'https://git.example',
          projectRef: 'team/app', targetBranch: 'main', credentialsRef: 'env:FIXTURE_GITLAB_TOKEN' }],
      },
    }));
    const preload = join(directory, 'fail-fetch.mjs');
    writeFileSync(preload, `globalThis.fetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    };`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('AGENT_PLATFORM_') && !['JAVA_HOME', 'MAVEN_SETTINGS', 'DEVOPS_CREDENTIALS_PATH'].includes(key)));
    service = spawn(process.execPath, ['--import', preload, join(root, 'dist/bootstrap/main.js')], {
      cwd: directory, env: { ...env, GIT_DIR: join(root, '.git'), FIXTURE_GITLAB_TOKEN: 'fixture-token',
        AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH: join(directory, 'code-host.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    service.stderr?.on('data', chunk => { stderr += String(chunk); });
    await waitForReady(service);
    const response = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { stage5WritesEnabled: boolean }).stage5WritesEnabled, false);
    assert.match(stderr, /unreachable-host/);
    assert.match(stderr, /UND_ERR_SOCKET/);
  } finally {
    await stop(service);
    rmSync(directory, { recursive: true, force: true });
  }
});
