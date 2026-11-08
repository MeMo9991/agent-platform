import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from './kernel-fixture.js';
import { startLocalApi } from '../src/api/local.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function saveApprovedTask(store: SqliteStore, state: 'ready_to_merge' | 'waiting_human', at: string) {
  store.saveTask({ id: 'task', repoKey: 'repo', title: 'Task', scope: 'Task', state,
    iteration: 1, priority: 0, baseRef: 'c'.repeat(40), createdAt: at, updatedAt: at,
    mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Task',
      allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'v1',
      authority: { kind: 'trusted_rule', ruleRef: 'fixture' } } });
  const current = store.getTask('task')!;
  const approved = { ...current, mandate: { ...current.mandate,
    allowedActions: ['investigate', 'edit', 'open_pr', 'merge'] as const, maxAutoRisk: 'high' as const,
    authority: { kind: 'human_approval' as const, approvalRef: 'scope' } } };
  store.db.prepare('UPDATE task SET mandate=?,payload_json=? WHERE id=?')
    .run(JSON.stringify(approved.mandate), JSON.stringify(approved), 'task');
}

test('action approval binds reviewed source, target and policy without resuming development', async () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sourceSha = 'a'.repeat(40);
  const targetSha = 'b'.repeat(40);
  try {
    saveApprovedTask(store, 'ready_to_merge', at);
    store.saveRecord({ id: 'review', taskId: 'task', kind: 'review', subjectSha: sourceSha,
      iteration: 1, verdict: 'pass', findings: [], at });
    store.saveTransition('task', 'waiting_human', 'Action approval', at, 'waiting', { kind: 'system', id: 'test' });
    store.saveApprovalRequest({ kind: 'action', id: 'request', taskId: 'task', action: 'open_pr',
      sourceSha, reviewRecordId: 'review', targetBranch: 'main', targetSha, policyVersion: 'v1' });
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: 'request', decision: 'approve', actor: { kind: 'human', id: 'owner' },
        at, idempotencyKey: 'approval-key' } } });
    const input = { taskId: 'task', action: 'open_pr' as const, sourceSha,
      targetBranch: 'main', targetSha, policyVersion: 'v1' };
    assert.equal(store.getTask('task')?.state, 'ready_to_merge');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='develop'").get()?.n, 0);
    assert.equal(store.hasActionApproval(input), true);
    assert.equal(store.hasActionApproval({ ...input, targetSha: 'd'.repeat(40) }), false);
    assert.equal(store.hasActionApproval({ ...input, policyVersion: 'v2' }), false);
    store.saveRecord({ id: 'new-review', taskId: 'task', kind: 'review', subjectSha: 'e'.repeat(40),
      iteration: 1, verdict: 'pass', findings: [], at: new Date(Date.now() + 1000).toISOString() });
    assert.equal(store.hasActionApproval(input), false);
  } finally { store.close(); }
});

test('action approval cannot be requested without a passing review', () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  try {
    saveApprovedTask(store, 'waiting_human', at);
    assert.throws(() => store.saveApprovalRequest({ kind: 'action', id: 'request', taskId: 'task',
      action: 'open_pr', sourceSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
      reviewRecordId: 'review', policyVersion: 'v1' }), /does not match/);
  } finally { store.close(); }
});

test('blocking findings require a decision for every item and invalidate earlier action approval', () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sourceSha = 'a'.repeat(40);
  try {
    saveApprovedTask(store, 'waiting_human', at);
    store.saveRecord({ id: 'review-pass', taskId: 'task', kind: 'review', iteration: 1,
      subjectSha: sourceSha, verdict: 'pass', findings: [], at });
    store.saveApprovalRequest({ kind: 'action', id: 'request', taskId: 'task', action: 'open_pr',
      sourceSha, reviewRecordId: 'review-pass', targetBranch: 'main', targetSha: 'b'.repeat(40), policyVersion: 'v1' });
    store.recordApproval({ requestId: 'request', actor: { kind: 'human', id: 'owner' },
      decision: 'approve', at, idempotencyKey: 'approve' });
    store.saveTransition('task', 'ready_to_merge', 'Approved action', at, 'ready', { kind: 'human', id: 'owner' });
    const input = { taskId: 'task', action: 'open_pr' as const, sourceSha,
      targetBranch: 'main', targetSha: 'b'.repeat(40), policyVersion: 'v1' };
    assert.equal(store.hasActionApproval(input), true);
    const later = new Date(Date.now() + 1000).toISOString();
    store.saveRecord({ id: 'review-block', taskId: 'task', kind: 'review', iteration: 1,
      subjectSha: sourceSha, verdict: 'block', findings: [
        { file: 'src/a.ts', severity: 'high', evidence: 'A', impact: 'A' },
        { file: 'src/b.ts', severity: 'high', evidence: 'B', impact: 'B' },
      ], at: later });
    assert.equal(store.latestReviewedSha('task'), undefined);
    assert.equal(store.hasActionApproval(input), false);
    store.saveTransition('task', 'waiting_human', 'Resolve review', later, 'waiting-again', { kind: 'system', id: 'test' });
    const resolution = { id: 'resolution-1', taskId: 'task', kind: 'review_resolution' as const,
      reviewRecordId: 'review-block', findingIndex: 0, subjectSha: sourceSha,
      disposition: 'false_positive' as const, reason: 'Checked against the cited line',
      idempotencyKey: 'resolve-1', actor: { kind: 'human' as const, id: 'owner' }, at: later };
    assert.equal(store.saveReviewResolution(resolution), false);
    assert.throws(() => store.saveReviewResolution({ ...resolution, id: 'duplicate-index',
      idempotencyKey: 'different' }), /already resolved/);
    assert.equal(store.saveReviewResolution({ ...resolution, id: 'resolution-2', findingIndex: 1,
      idempotencyKey: 'resolve-2', reason: 'Risk accepted for this SHA' }), true);
    assert.equal(store.latestReviewedSha('task'), sourceSha);
    assert.equal(store.hasActionApproval(input), false);
  } finally { store.close(); }
});

test('review resolution API binds the approver identity and current Task version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage5-review-'));
  const store = new SqliteStore(':memory:');
  let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  const at = new Date().toISOString();
  let writes = 0;
  try {
    saveApprovedTask(store, 'waiting_human', at);
    store.saveRecord({ id: 'block', taskId: 'task', kind: 'review', iteration: 1,
      subjectSha: 'a'.repeat(40), verdict: 'block', findings: [
        { file: 'src/a.ts', severity: 'high', evidence: 'A', impact: 'A' }], at });
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    api = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'credential'),
      actorId: 'local-owner', roles: ['approve'], dashboard: { actorId: 'local-owner',
        repoKeys: ['repo'], imageDirectory: directory, attachmentReaders: {},
        stage5OpenChange: { async prepare() { throw new Error('Unexpected prepare'); },
          async execute() { writes++; return {}; }, async status() { return {}; },
          async prepareMerge() { return {}; }, async observeManualMerge() { return 'pending' as const; } } } });
    const token = readFileSync(join(directory, 'credential'), 'utf8');
    const blockedWrite = await fetch(`http://127.0.0.1:${api.port}/api/tasks/task/open-change/execute`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }) });
    assert.equal(blockedWrite.status, 409);
    assert.equal(writes, 0);
    const url = `http://127.0.0.1:${api.port}/api/tasks/task/review-resolutions`;
    const send = (value: unknown) => fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const input = { expectedVersion: Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version),
      reviewRecordId: 'block', findingIndex: 0, subjectSha: 'a'.repeat(40),
      disposition: 'false_positive', reason: 'Verified cited line', idempotencyKey: 'decision' };
    assert.equal((await send({ ...input, actor: { kind: 'human', id: 'attacker' } })).status, 400);
    assert.equal((await send({ ...input, expectedVersion: input.expectedVersion - 1 })).status, 409);
    assert.equal((await send(input)).status, 200);
    assert.equal(store.getTask('task')?.state, 'ready_to_merge');
    const saved = store.getRecord(String(store.db.prepare("SELECT id FROM task_record WHERE kind='review_resolution'").get()?.id));
    assert.equal(saved?.kind === 'review_resolution' && saved.actor.id, 'local-owner');
  } finally { await api?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
