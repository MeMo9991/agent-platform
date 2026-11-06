import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorkspaceManager } from '../src/agent/worker/workspace.js';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from './kernel-fixture.js';
import { createWorkerManager } from '../src/agent/worker/manager.js';

test('development Git proof checks repository, ancestor, clean HEAD and nonempty diff', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-development-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/MeMo9991/agent-platform.git');
    writeFileSync(join(repo, 'file.txt'), 'before\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const run = { id: 'run-1', taskId: 'task-1', iteration: 1, stage: 'develop' as const,
      status: 'running' as const, priority: 0, attempt: 1, createdAt: new Date().toISOString() };
    const manager = createGitWorkspaceManager({ 'agent-platform': { path: repo,
      remote: 'https://github.com/MeMo9991/agent-platform.git' } }, join(directory, 'runtime'), () => 'agent-platform');
    await assert.rejects(manager.prepare({ ...run, id: '../escape' }), /safe clone name/);
    const workspace = await manager.prepare(run);
    assert.ok(existsSync(join(workspace.path, '.git')));
    assert.equal(existsSync(join(workspace.path, '.git', 'objects', 'info', 'alternates')), false);
    assert.equal(git(workspace.path, 'rev-parse', '--git-common-dir'), '.git');
    assert.notEqual(git(repo, 'rev-parse', '--git-common-dir'), join(workspace.path, '.git'));
    const execution = { ...run, workspaceRef: workspace.path, commitSha: workspace.baseSha };
    assert.equal((await manager.prepare(execution)).path, workspace.path);
    writeFileSync(join(workspace.path, 'file.txt'), 'unexpected\n');
    await assert.rejects(manager.prepare(execution), /uncommitted changes before reuse/);
    git(workspace.path, 'checkout', '--', 'file.txt');
    writeFileSync(join(workspace.path, 'file.txt'), 'after\n');
    git(workspace.path, 'add', '.'); git(workspace.path, 'commit', '-qm', 'fix');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), workspace.baseSha);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    await assert.rejects(manager.prepare(execution), /HEAD changed before reuse/);
    const proof = await manager.verifyDevelopment!(execution);
    assert.equal(proof.baseSha, workspace.baseSha);
    assert.equal(proof.commitSha, git(workspace.path, 'rev-parse', 'HEAD'));
    assert.match(readFileSync(proof.diffRef, 'utf8'), /after/);
    await manager.verifyAfterChecks!(execution, proof.commitSha);
    writeFileSync(join(workspace.path, 'file.txt'), 'uncommitted\n');
    await assert.rejects(manager.verifyDevelopment!(execution), /uncommitted/);
    await assert.rejects(manager.verifyAfterChecks!(execution, proof.commitSha), /changed during local checks/);
    git(workspace.path, 'add', '.'); git(workspace.path, 'commit', '-qm', 'check changed HEAD');
    await assert.rejects(manager.verifyAfterChecks!(execution, proof.commitSha), /HEAD changed/);
    git(workspace.path, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git');
    await assert.rejects(manager.verifyDevelopment!(execution), /identity or origin/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const outcome of ['passed', 'timeout', 'unavailable', 'unterminated', 'terminate-throws', 'mutated'] as const) test(`isolated local check ${outcome} is recorded and gates verify`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-check-'));
  const store = new SqliteStore(':memory:', { fixture: [] });
  try {
    store.registerSource('fixture', 'fixture', 'fixture', true);
    const incoming = store.accept({ sourceId: 'fixture', externalId: 'e1', revision: '1', kind: 'bug',
      title: 'Bug', body: 'Body', repoKey: 'agent-platform', attachments: [], metaData: {} });
    const coordinator = createKernelCoordinator(store, { fixture: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    coordinator.processPending();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const first = store.getRun(String(store.db.prepare('SELECT id FROM run').get()?.id))!;
    store.replaceRun({ ...first, status: 'succeeded' }, 'queued');
    store.setEventLinkStatus(taskId, incoming.eventId, 'pending', 'delivered');
    const baseSha = 'a'.repeat(40);
    const commitSha = 'b'.repeat(40);
    store.setTaskBaseRef(taskId, baseSha);
    store.saveTransition(taskId, 'investigating', 'started', new Date().toISOString(), 's1', { kind: 'system', id: 'test' });
    store.saveTransition(taskId, 'waiting_human', 'scope', new Date().toISOString(), 's2', { kind: 'system', id: 'test' });
    const current = store.getTask(taskId)!;
    store.saveApprovalRequest({ kind: 'scope_change', id: 'scope', taskId, iteration: 1,
      sourceSha: baseSha, policyVersion: 'p1', proposedMandate: { ...current.mandate,
        allowedActions: ['investigate', 'edit'], authority: { kind: 'human_approval', approvalRef: 'scope' } } });
    await coordinator.onSignal({ kind: 'human_response', taskId, response: { kind: 'approval_decision', value: { requestId: 'scope', actor: { kind: 'human', id: 'owner' }, decision: 'approve',
      at: new Date().toISOString(), idempotencyKey: 'approval-key' } } });
    const logRef = join(directory, 'check.log');
    writeFileSync(logRef, outcome);
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { return { sessionId: 'session' }; }, async resume() { return { kind: 'unsupported' }; },
        async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'finished',
          runId: String(store.db.prepare("SELECT id FROM run WHERE stage='develop'").get()?.id),
          exitCode: 0, resultRef: 'report' }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/isolated', baseSha }; },
        async verifyDevelopment(run) { assert.equal(run.commitSha, baseSha);
          return { baseSha, commitSha, diffRef: join(directory, 'diff.patch') }; },
        async verifyAfterChecks(_run, expected) { assert.equal(expected, commitSha);
          if (outcome === 'mutated') throw new Error('Development worktree changed during local checks'); } },
      skills: { async load(ref) { return { ref, content: 'Develop' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'write', adapterVersion: 'test', configDigest: 'digest' }; },
      runCheck(value) { assert.equal(value.proof.mode, 'write');
        assert.equal(value.command, 'npm'); assert.deepEqual(value.args, ['test']);
        assert.equal(value.cwd, '/tmp/isolated');
        if (outcome === 'unavailable') throw new Error('Check could not start');
        let terminated = false;
        return { completion: outcome === 'timeout' || outcome === 'unterminated' || outcome === 'terminate-throws' ? new Promise<never>(() => {})
          : Promise.resolve({ result: 'passed' as const, exitCode: 0, logRef, terminationConfirmed: true }),
          async terminate() { if (outcome === 'unterminated') return new Promise<never>(() => {});
            if (outcome === 'terminate-throws') throw new Error('Termination failed');
            terminated = true; return { terminated, logRef }; } }; } },
      riskPolicy: { assess() { return 'low'; } }, policyVersion: 'p1',
      localChecks: { 'agent-platform': [{ command: 'npm', args: ['test'],
        timeoutMs: outcome === 'timeout' || outcome === 'unterminated' || outcome === 'terminate-throws' ? 20 : 5000 }] },
      skillRepoPath: 'agent-platform', skillCommitSha: baseSha, maxRunMs: 60_000,
      checkLogDirectory: join(directory, 'fallback-logs'),
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    const startedPoll = Date.now();
    assert.equal(await manager.poll(), 1);
    if (outcome === 'unterminated') assert.ok(Date.now() - startedPoll < 6000);
    const check = store.getRecord(String(store.db.prepare("SELECT id FROM task_record WHERE kind='check'").get()?.id));
    assert.equal(check?.kind, 'check');
    if (check?.kind === 'check') {
      assert.deepEqual(check.args, ['test']);
      assert.equal(check.result, outcome === 'mutated' ? 'passed' : ['unterminated', 'terminate-throws'].includes(outcome) ? 'unavailable' : outcome);
      assert.equal(check.exitCode, ['passed', 'mutated'].includes(outcome) ? 0 : null);
      assert.ok(check.startedAt <= check.endedAt);
      assert.equal(existsSync(check.logRef), true);
      assert.equal(check.terminationConfirmed, !['unavailable', 'unterminated', 'terminate-throws'].includes(outcome));
    }
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='development'").get()?.n, 1);
    const development = store.getRecord(String(store.db.prepare("SELECT id FROM task_record WHERE kind='development'").get()?.id));
    assert.equal(development?.kind, 'development');
    if (development?.kind === 'development') assert.equal(development.postCheckVerified,
      outcome === 'passed' || outcome === 'timeout');
    assert.equal(store.getTask(taskId)?.state, outcome === 'passed' ? 'verifying' : 'blocked');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='verify'").get()?.n,
      outcome === 'passed' ? 1 : 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
