import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from './kernel-fixture.js';
import { startLocalApi } from '../src/api/local.js';
import { executeTaskCommand } from '../src/api/task-command.js';
import { parseReviewOutput } from '../src/agent/worker/manager.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function saveApprovedTask(store: SqliteStore, state: 'ready_to_merge' | 'waiting_human' | 'reviewing' | 'blocked', at: string) {
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

test('review accepts only a raw object or one validated JSON code block', () => {
  const object = JSON.stringify({ subjectSha: 'a'.repeat(40), verdict: 'pass', findings: [] });
  assert.equal(parseReviewOutput(object).verdict, 'pass');
  assert.equal(parseReviewOutput(`Analysis.\n\n\`\`\`json\n${object}\n\`\`\``).subjectSha, 'a'.repeat(40));
  assert.equal(parseReviewOutput(`Analysis.\n\n${object}`).subjectSha, 'a'.repeat(40));
  assert.throws(() => parseReviewOutput(`\`\`\`json\n${object}\n\`\`\`\n\`\`\`json\n${object}\n\`\`\``));
  assert.throws(() => parseReviewOutput(`Analysis.\n${object}\nAfterword`));
  assert.throws(() => parseReviewOutput(`${object}\n${object}`));
  assert.throws(() => parseReviewOutput(`Analysis.\n\`\`\`json\n{"subjectSha":"bad","verdict":"pass","findings":[]}\n\`\`\``));
  assert.throws(() => parseReviewOutput(JSON.stringify({ subjectSha: 'a'.repeat(40), verdict: 'pass',
    findings: [{ file: 'file.txt', severity: 'info', evidence: 'No issue', impact: 'None',
      action: 'No action', verificationMethod: 'Read file' }] })));
  assert.throws(() => parseReviewOutput(`The review passes for ${'a'.repeat(40)}`));
});

test('latest review uses insertion order when timestamps are equal', () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  try {
    saveApprovedTask(store, 'reviewing', at);
    store.saveRecord({ id: 'z-block', taskId: 'task', kind: 'review', iteration: 1,
      subjectSha: 'a'.repeat(40), verdict: 'block', findings: [], at });
    store.saveRecord({ id: 'a-pass', taskId: 'task', kind: 'review', iteration: 1,
      subjectSha: 'a'.repeat(40), verdict: 'pass', findings: [], at });
    assert.equal(store.latestReview('task')?.id, 'a-pass');
    assert.equal(store.latestReviewedSha('task'), 'a'.repeat(40));
  } finally { store.close(); }
});

test('failed verify can be retried on the same reviewed development SHA', async () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sha = 'a'.repeat(40);
  try {
    saveApprovedTask(store, 'blocked', at);
    store.saveRecord({ id: 'development', taskId: 'task', runId: 'develop-run', kind: 'development',
      baseSha: 'c'.repeat(40), commitSha: sha, diffRef: '/tmp/diff.patch', postCheckVerified: true, at });
    store.saveRun({ id: 'verify-run', taskId: 'task', iteration: 1, stage: 'verify', status: 'failed',
      priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha, createdAt: at });
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'retry', taskId: 'task', expectedVersion: version,
      reason: 'Retry after isolated test configuration changed', idempotencyKey: 'verify-retry' });
    const row = store.db.prepare("SELECT id FROM run WHERE task_id=? AND status='queued'").get('task');
    const retry = store.getRun(String(row?.id))!;
    assert.equal(retry.stage, 'verify');
    assert.equal(retry.commitSha, sha);
    store.replaceRun({ ...retry, status: 'running' }, 'queued');
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'progress', runId: retry.id, text: 'Verifying pinned SHA' } });
    assert.equal(store.getTask('task')?.state, 'verifying');
  } finally { store.close(); }
});

test('failed review output can be retried on its verified SHA without accepting prose', async () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sha = 'a'.repeat(40);
  try {
    saveApprovedTask(store, 'blocked', at);
    store.saveRun({ id: 'verify-run', taskId: 'task', iteration: 1, stage: 'verify', status: 'succeeded',
      priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha, createdAt: at });
    store.saveRun({ id: 'review-run', taskId: 'task', iteration: 1, stage: 'review', status: 'failed',
      priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha,
      createdAt: new Date(Date.parse(at) + 1000).toISOString() });
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'retry', taskId: 'task', expectedVersion: version,
      reason: 'Retry malformed structured review output', idempotencyKey: 'review-retry' });
    const row = store.db.prepare("SELECT id FROM run WHERE task_id=? AND status='queued'").get('task');
    const retry = store.getRun(String(row?.id))!;
    assert.equal(retry.stage, 'review');
    assert.equal(retry.commitSha, sha);
    store.replaceRun({ ...retry, status: 'running' }, 'queued');
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'progress', runId: retry.id, text: 'Reviewing pinned SHA' } });
    assert.equal(store.getTask('task')?.state, 'reviewing');
  } finally { store.close(); }
});

test('unsupported review severity can be re-reviewed after an unchanged repair failure', async () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sha = 'a'.repeat(40);
  try {
    saveApprovedTask(store, 'blocked', at);
    store.saveRun({ id: 'verify-run', taskId: 'task', iteration: 1, stage: 'verify', status: 'succeeded',
      priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha, createdAt: at });
    store.saveRun({ id: 'review-run', taskId: 'task', iteration: 1, stage: 'review', status: 'succeeded',
      priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha,
      createdAt: new Date(Date.parse(at) + 1000).toISOString() });
    store.saveRecord({ id: 'review', taskId: 'task', runId: 'review-run', kind: 'review',
      iteration: 1, subjectSha: sha, verdict: 'pass', findings: [{ file: 'file.txt', severity: 'info',
        evidence: 'No issue', impact: 'None' }], at: new Date(Date.parse(at) + 1000).toISOString() });
    store.saveRun({ id: 'repair-run', taskId: 'task', iteration: 1, stage: 'develop', status: 'failed',
      priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha,
      createdAt: new Date(Date.parse(at) + 2000).toISOString() });
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'retry', taskId: 'task', expectedVersion: version,
      reason: 'Re-review unsupported informational severity', idempotencyKey: 'review-severity-retry' });
    const row = store.db.prepare("SELECT id FROM run WHERE task_id=? AND status='queued'").get('task');
    const retry = store.getRun(String(row?.id))!;
    assert.equal(retry.stage, 'review');
    assert.equal(retry.commitSha, sha);
    assert.equal(store.latestReview('task')?.id, 'review');
  } finally { store.close(); }
});

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
    store.saveRecord({ id: 'contradictory-review', taskId: 'task', kind: 'review', subjectSha: sourceSha,
      iteration: 1, verdict: 'pass', findings: [{ file: 'src/a.ts', severity: 'high',
        evidence: 'Regression', impact: 'Breaks behavior' }], at: new Date(Date.now() + 2000).toISOString() });
    assert.equal(store.latestReviewedSha('task'), undefined);
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
    for (const index of [0, 1]) store.saveRecord({ id: `published-${index}`, taskId: 'task',
      kind: 'review_finding_publication', reviewRecordId: 'review-block', findingIndex: index,
      subjectSha: sourceSha, file: `src/${index}.ts`, severity: 'high', evidence: 'Reviewed evidence',
      impact: 'Reviewed impact', status: 'published', actor: { kind: 'human', id: 'reviewer' },
      idempotencyKey: `publish-${index}`, at: later });
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
    saveApprovedTask(store, 'reviewing', at);
    for (let index = 0; index < 2; index++) {
      store.saveRun({ id: `prior-${index}`, taskId: 'task', iteration: 1, stage: 'review',
        status: 'succeeded', priority: 0, attempt: index + 1, agentKind: 'qoder',
        commitSha: 'a'.repeat(40), createdAt: new Date(Date.now() - (index + 2) * 1000).toISOString() });
      store.saveRecord({ id: `prior-review-${index}`, taskId: 'task', runId: `prior-${index}`,
        kind: 'review', iteration: 1, subjectSha: 'a'.repeat(40), verdict: 'pass',
        findings: [{ file: 'src/a.ts', severity: 'high', evidence: 'A', impact: 'A' }],
        at: new Date(Date.now() - (index + 2) * 1000).toISOString() });
    }
    store.saveRun({ id: 'current-review', taskId: 'task', iteration: 1, stage: 'review',
      status: 'running', priority: 0, attempt: 3, agentKind: 'qoder',
      commitSha: 'a'.repeat(40), createdAt: at });
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task', event: { kind: 'result',
      runId: 'current-review', status: 'succeeded', exitCode: 0, resultRef: 'review-result',
      review: { subjectSha: 'a'.repeat(40), verdict: 'pass', findings: [
        { file: 'src/a.ts', severity: 'high', evidence: 'A', impact: 'A' }] } } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.countReviewBlocks('task', 1), 3);
    assert.equal(store.latestReviewedSha('task'), undefined);
    const reviewId = store.latestReview('task')!.id;
    api = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'credential'),
      actorId: 'local-owner', roles: ['approve', 'command'], dashboard: { actorId: 'local-owner',
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
      reviewRecordId: reviewId, findingIndex: 0, subjectSha: 'a'.repeat(40),
      disposition: 'false_positive', reason: 'Verified cited line', idempotencyKey: 'decision' };
    assert.equal((await send(input)).status, 409);
    const publish = (value: unknown) => fetch(`http://127.0.0.1:${api!.port}/api/tasks/task/review-findings`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(value) });
    const publication = { expectedVersion: input.expectedVersion, reviewRecordId: reviewId,
      findingIndex: 0, subjectSha: input.subjectSha, file: 'src/a.ts', severity: 'high',
      evidence: 'Confirmed regression', impact: 'Breaks current behavior', idempotencyKey: 'publish-one' };
    assert.equal((await publish({ ...publication, findingIndex: 1 })).status, 409);
    assert.equal((await publish({ ...publication, subjectSha: 'b'.repeat(40) })).status, 409);
    assert.equal((await publish(publication)).status, 200);
    const detail = await fetch(`http://127.0.0.1:${api.port}/api/tasks/task`,
      { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()) as { records: Record<string, unknown>[] };
    assert.equal(detail.records.find(record => record.id === reviewId)?.findings, undefined);
    const shown = detail.records.find(record => record.kind === 'review_finding_publication');
    assert.equal(shown?.reviewRecordId, reviewId);
    assert.equal(shown?.findingIndex, 0);
    assert.equal(shown?.subjectSha, input.subjectSha);
    assert.equal(shown?.file, 'src/a.ts');
    assert.equal(shown?.evidence, 'Confirmed regression');
    assert.equal(shown?.impact, 'Breaks current behavior');
    assert.equal((await publish({ ...publication, file: 'src/other.ts', idempotencyKey: 'publish-again' })).status, 409);
    assert.equal((await send({ ...input, actor: { kind: 'human', id: 'attacker' } })).status, 400);
    assert.equal((await send({ ...input, expectedVersion: input.expectedVersion - 1 })).status, 409);
    assert.equal((await send(input)).status, 200);
    assert.equal(store.getTask('task')?.state, 'ready_to_merge');
    const saved = store.getRecord(String(store.db.prepare("SELECT id FROM task_record WHERE kind='review_resolution'").get()?.id));
    assert.equal(saved?.kind === 'review_resolution' && saved.actor.id, 'local-owner');
  } finally { await api?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('empty blocking review requires human retry on the same SHA before merge readiness', async () => {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  const sourceSha = 'a'.repeat(40);
  try {
    saveApprovedTask(store, 'reviewing', at);
    store.saveRun({ id: 'first-review', taskId: 'task', iteration: 1, stage: 'review',
      status: 'running', priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sourceSha, createdAt: at });
    const coordinator = createKernelCoordinator(store, {}, 'v1', 'fixture', 'qoder', ['repo']);
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task', event: { kind: 'result',
      runId: 'first-review', status: 'succeeded', exitCode: 0, resultRef: 'first-result',
      review: { subjectSha: sourceSha, verdict: 'block', findings: [] } } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.latestReviewedSha('task'), undefined);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='develop'").get()?.n, 0);
    assert.throws(() => store.saveReviewResolution({ id: 'fabricated', taskId: 'task',
      kind: 'review_resolution', reviewRecordId: store.latestReview('task')!.id, findingIndex: 0,
      subjectSha: sourceSha, disposition: 'false_positive', reason: 'No finding exists',
      idempotencyKey: 'fabricated', actor: { kind: 'human', id: 'owner' }, at }), /stale/);
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'retry', taskId: 'task', expectedVersion: version,
      reason: 'Review supplied no actionable finding', idempotencyKey: 'retry-empty-review' });
    assert.equal(store.getTask('task')?.state, 'reviewing');
    const row = store.db.prepare('SELECT id FROM run WHERE task_id=? AND status=?').get('task', 'queued');
    const retry = store.getRun(String(row?.id))!;
    assert.equal(retry.stage, 'review');
    assert.equal(retry.commitSha, sourceSha);
    assert.equal(retry.attempt, 2);
    store.replaceRun({ ...retry, status: 'running' }, 'queued');
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task', event: { kind: 'result',
      runId: retry.id, status: 'succeeded', exitCode: 0, resultRef: 'second-result',
      review: { subjectSha: sourceSha, verdict: 'pass', findings: [] } } });
    assert.equal(store.getTask('task')?.state, 'ready_to_merge');
    assert.equal(store.latestReviewedSha('task'), sourceSha);
  } finally { store.close(); }
});
