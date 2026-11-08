import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createStage5OpenChange } from '../src/authorization/stage5-open-change.js';
import { createKernelCoordinator } from './kernel-fixture.js';
import type { CodeHost } from '../src/repository-ci/model.js';

test('opening a change requests approval for the reviewed SHA and rechecks the target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage5-open-change-'));
  const store = new SqliteStore(':memory:');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const at = new Date().toISOString();
  const target = 'b'.repeat(40);
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'Test');
    writeFileSync(join(directory, 'feature.ts'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'feature.ts'), 'changed\n');
    git('add', '.'); git('commit', '-qm', 'change');
    const sourceSha = git('rev-parse', 'HEAD');
    store.saveTask({ id: 'task', repoKey: 'repo', title: 'Fix', scope: 'Fix', state: 'ready_to_merge',
      iteration: 1, priority: 0, baseRef: baseSha, createdAt: at, updatedAt: at,
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Fix', allowedActions: ['investigate'],
        maxAutoRisk: 'low', policyVersion: 'v1', authority: { kind: 'trusted_rule', ruleRef: 'fixture' } } });
    const current = store.getTask('task')!;
    const approved = { ...current, mandate: { ...current.mandate,
      allowedActions: ['investigate', 'edit', 'open_pr'] as const, maxAutoRisk: 'high' as const,
      authority: { kind: 'human_approval' as const, approvalRef: 'scope' } } };
    store.db.prepare('UPDATE task SET mandate=?,payload_json=? WHERE id=?')
      .run(JSON.stringify(approved.mandate), JSON.stringify(approved), 'task');
    for (const stage of ['develop', 'verify', 'review'] as const) store.saveRun({ id: stage,
      taskId: 'task', iteration: 1, stage, status: 'succeeded', priority: 0, attempt: 0,
      commitSha: sourceSha, workspaceRef: directory, createdAt: at });
    store.saveRecord({ id: 'development', taskId: 'task', runId: 'develop', kind: 'development',
      baseSha, commitSha: sourceSha, diffRef: 'fixture', postCheckVerified: true, at });
    store.saveRecord({ id: 'check', taskId: 'task', runId: 'verify', kind: 'check', subjectSha: sourceSha,
      command: 'npm', args: ['test'], timeoutMs: 1000, startedAt: at, endedAt: at,
      result: 'passed', exitCode: 0, logRef: 'fixture', terminationConfirmed: true, at });
    store.saveRecord({ id: 'review-record', taskId: 'task', runId: 'review', kind: 'review',
      iteration: 1, subjectSha: sourceSha, verdict: 'pass', findings: [], at });
    const repo = { repoKey: 'repo', provider: 'github' as const, hostUrl: 'https://github.com',
      projectRef: 'team/repo', targetBranch: 'main', requiredChecks: ['verify'],
      credentialsRef: 'env:TEST_TOKEN', localChecks: [] };
    let currentTarget = target;
    let platformRequired = ['verify'];
    let existingChange: Awaited<ReturnType<NonNullable<CodeHost['findChangeByBranch']>>>;
    let failCreate = false;
    const host: CodeHost = { repoKey: 'repo', provider: 'github',
      async readTarget() { return currentTarget; }, async readChecks() { return []; },
      async readRequiredChecks() { return platformRequired; },
      async findChangeByBranch() { return existingChange; },
      async openChange() { if (failCreate) throw new Error('Timeout after create request');
        existingChange = { provider: 'github', repoKey: 'repo', id: '42',
        sourceSha, targetSha: currentTarget }; return existingChange; },
      async readChange(change) { return { change: { ...change, targetSha: currentTarget },
        state: 'open', sourceSha, targetSha: currentTarget, gate: 'ready',
        checks: [{ repoKey: 'repo', commitSha: sourceSha, name: 'verify',
          status: 'completed', conclusion: 'success' }], observedAt: new Date().toISOString() }; },
      async merge() { throw new Error('No merge expected'); } };
    let pushes = 0;
    const service = createStage5OpenChange(store, { repo }, { repo: host },
      { async prepare() { throw new Error('No clone expected'); },
        async verifyAfterChecks() {} }, 'v1', async () => { pushes++; });
    const version = () => Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
    const request = await service.prepare('task', version());
    assert.equal(request.kind, 'action_request');
    assert.equal(request.sourceSha, sourceSha);
    assert.equal(request.targetSha, target);
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: request.requestId!, decision: 'approve', actor: { kind: 'human', id: 'owner' },
        at, idempotencyKey: 'approve' } } });
    assert.equal((await service.prepare('task', version())).kind, 'ready');
    assert.deepEqual(await service.execute('task', version()), { kind: 'opened', changeId: '42' });
    assert.deepEqual(await service.execute('task', version()), { kind: 'opened', changeId: '42' });
    assert.equal(pushes, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='effect'").get()?.n, 1);
    assert.equal((await service.status('task')).ready, true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='ci'").get()?.n, 1);
    platformRequired = ['verify', 'security'];
    assert.equal((await service.status('task')).ready, false);
    platformRequired = ['verify'];
    const mergeScope = await service.prepareMerge('task', version());
    assert.equal(mergeScope.kind, 'scope_request');
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: mergeScope.requestId!, decision: 'approve', actor: { kind: 'human', id: 'owner' },
        at, idempotencyKey: 'merge-scope' } } });
    const mergeAction = await service.prepareMerge('task', version());
    assert.equal(mergeAction.kind, 'action_request');
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: mergeAction.requestId!, decision: 'approve', actor: { kind: 'human', id: 'owner' },
        at, idempotencyKey: 'merge-action' } } });
    assert.equal((await service.prepareMerge('task', version())).kind, 'manual_ready');
    currentTarget = 'c'.repeat(40);
    assert.equal((await service.status('task')).ready, false);
    await assert.rejects(service.prepareMerge('task', version()), /not ready/);
    const second = await service.prepare('task', version());
    assert.equal(second.kind, 'action_request');
    existingChange = undefined;
    failCreate = true;
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: second.requestId!, decision: 'approve', actor: { kind: 'human', id: 'owner' },
        at, idempotencyKey: 'approve-second' } } });
    assert.deepEqual(await service.execute('task', version()), { kind: 'uncertain' });
    assert.deepEqual(await service.execute('task', version()), { kind: 'uncertain' });
    assert.equal(pushes, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('manual merge advances only after the platform proves the approved target parent', async () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sourceSha = 'a'.repeat(40);
  const targetSha = 'b'.repeat(40);
  const mergedSha = 'c'.repeat(40);
  try {
    store.saveTask({ id: 'task', repoKey: 'repo', title: 'Fix', scope: 'Fix', state: 'waiting_human',
      iteration: 1, priority: 0, createdAt: at, updatedAt: at,
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Fix', allowedActions: ['investigate'],
        maxAutoRisk: 'low', policyVersion: 'v1', authority: { kind: 'trusted_rule', ruleRef: 'fixture' } } });
    const current = store.getTask('task')!;
    const approved = { ...current, mandate: { ...current.mandate,
      allowedActions: ['investigate', 'edit', 'open_pr', 'merge'] as const, maxAutoRisk: 'high' as const,
      authority: { kind: 'human_approval' as const, approvalRef: 'scope' } } };
    store.db.prepare('UPDATE task SET mandate=?,payload_json=? WHERE id=?')
      .run(JSON.stringify(approved.mandate), JSON.stringify(approved), 'task');
    store.saveRecord({ id: 'review', taskId: 'task', kind: 'review', iteration: 1,
      subjectSha: sourceSha, verdict: 'pass', findings: [], at });
    store.saveApprovalRequest({ kind: 'action', id: 'approval', taskId: 'task', action: 'merge',
      sourceSha, reviewRecordId: 'review', targetBranch: 'main', targetSha,
      changeRef: '42', policyVersion: 'v1' });
    store.recordApproval({ requestId: 'approval', decision: 'approve', actor: { kind: 'human', id: 'owner' },
      at, idempotencyKey: 'approved' });
    store.saveTransition('task', 'ready_to_merge', 'Approved merge', at, 'ready', { kind: 'human', id: 'owner' });
    store.saveEffectIntent({ id: 'merge-intent', taskId: 'task', kind: 'effect', action: 'merge',
      idempotencyKey: 'merge-task', status: 'pending', subjectSha: sourceSha, at,
      request: { repoKey: 'repo', targetBranch: 'main', sourceSha, targetSha,
        changeId: '42', policyVersion: 'v1' } });
    const repo = { repoKey: 'repo', provider: 'github' as const, hostUrl: 'https://github.com',
      projectRef: 'team/repo', targetBranch: 'main', requiredChecks: ['verify'],
      credentialsRef: 'env:TEST_TOKEN', localChecks: [] };
    let parent = 'd'.repeat(40);
    const host: CodeHost = { repoKey: 'repo', provider: 'github', async readChecks() { return []; },
      async openChange() { throw new Error('No write expected'); }, async merge() { throw new Error('No merge expected'); },
      async readChange(change) { return { change, state: 'merged', sourceSha,
        targetSha: mergedSha, mergedSha, preMergeTargetSha: parent, checks: [], gate: 'ready', observedAt: at }; } };
    const service = createStage5OpenChange(store, { repo }, { repo: host },
      { async prepare() { throw new Error('No clone expected'); } }, 'v1');
    await assert.rejects(service.observeManualMerge('task'), /does not prove/);
    assert.equal(store.getTask('task')?.state, 'ready_to_merge');
    parent = targetSha;
    assert.equal(await service.observeManualMerge('task'), 'merged');
    assert.equal(store.getTask('task')?.state, 'release_pending');
    assert.equal(await service.observeManualMerge('task'), 'merged');
    const receipt = store.getRecord('merge-intent');
    assert.equal(receipt?.kind === 'effect' && receipt.receipt?.mergedSha, mergedSha);
  } finally { store.close(); }
});
