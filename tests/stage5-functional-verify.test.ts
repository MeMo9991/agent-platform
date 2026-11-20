import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from './kernel-fixture.js';
import { createWorkerManager } from '../src/agent/worker/manager.js';
import { executeTaskCommand } from '../src/api/task-command.js';

for (const verdict of ['pass', 'fail', 'unverifiable'] as const)
  test(`configured functional Agent ${verdict} controls the next stage`, async () => {
    const store = new SqliteStore(':memory:');
    const sha = 'b'.repeat(40);
    const at = new Date().toISOString();
    try {
      store.saveTask({ id: 'task', repoKey: 'repo', title: 'Fix endpoint', scope: 'Fix endpoint',
        mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Fix endpoint',
          allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
          authority: { kind: 'trusted_rule', ruleRef: 'test' } },
        state: 'verifying', iteration: 1, priority: 0, baseRef: 'a'.repeat(40), createdAt: at, updatedAt: at });
      store.saveRun({ id: 'verify', taskId: 'task', iteration: 1, stage: 'verify', status: 'succeeded',
        priority: 0, attempt: 0, agentKind: 'qoder', commitSha: sha, createdAt: at });
      store.saveRun({ id: 'functional', taskId: 'task', iteration: 1, stage: 'functional_verify', status: 'queued',
        priority: 0, attempt: 0, agentKind: 'qoder', commitSha: sha,
        createdAt: new Date(Date.parse(at) + 1000).toISOString() });
      const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['repo']);
      let prompt: Record<string, unknown> | undefined;
      const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
        runners: { qoder: {
          capabilities: () => ({ start: 'supported' as const, resume: 'unsupported' as const,
            send: 'unsupported' as const }),
          async start(request) { prompt = JSON.parse(request.input.kind === 'task' ? request.input.prompt : '{}');
            return { sessionId: 'functional-session' }; },
          async resume() { return { kind: 'unsupported' as const }; },
          async send() { return { kind: 'unsupported' as const }; },
          async read() { return { kind: 'finished' as const, runId: 'functional', exitCode: 0, resultRef: 'result' }; },
          async resultSummary() { return JSON.stringify({ subjectSha: sha, verdict, reason: 'Observed local response' }); },
          async cancel() { return { kind: 'accepted' as const }; },
        } },
        workspace: { async prepare() { return { repoKey: 'repo', path: '/tmp/functional-test', baseSha: sha }; },
          async verifyAfterChecks(_run, expected) { assert.equal(expected, sha); } },
        skills: { async load(ref) { return { ref, content: 'unused' }; } },
        boundary: { async attest(value) { return { verified: true, runId: value.runId,
          repoKey: value.repoKey, workspacePath: value.workspacePath, mode: 'read' as const,
          adapterVersion: 'test', configDigest: 'test' }; } },
        functionalVerificationUrls: { repo: 'http://127.0.0.1:8888' },
        skillRepoPath: 'repo', skillCommitSha: sha, maxRunMs: 60_000,
        enabledStages: ['functional_verify'],
        limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2,
          reservedHumanResume: 1 } });
      assert.equal(await manager.tick(), true);
      assert.equal(prompt?.functionalVerificationUrl, 'http://127.0.0.1:8888');
      assert.equal(prompt?.baseSha, sha);
      assert.equal(await manager.poll(), 1);
      assert.equal(store.getTask('task')?.state, verdict === 'pass' ? 'reviewing'
        : verdict === 'fail' ? 'developing' : 'waiting_human');
      assert.equal(store.db.prepare('SELECT stage FROM run WHERE id != ? ORDER BY rowid DESC LIMIT 1')
        .get('functional')?.stage, verdict === 'pass' ? 'review' : verdict === 'fail' ? 'develop' : 'verify');
      assert.equal(store.countFunctionalFailures('task', 1), verdict === 'fail' ? 1 : 0);
      if (verdict === 'unverifiable') {
        const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
        await executeTaskCommand(store, {}, 'owner', { kind: 'retry', taskId: 'task',
          expectedVersion: version, idempotencyKey: 'retry-functional', reason: 'Local service is now ready' });
        assert.equal(store.getTask('task')?.state, 'queued');
        assert.equal(store.db.prepare("SELECT stage FROM run WHERE task_id='task' ORDER BY rowid DESC LIMIT 1")
          .get()?.stage, 'functional_verify');
      }
    } finally { store.close(); }
  });

function interruptedFunctional(status: 'running' | 'paused' = 'running') {
  const store = new SqliteStore(':memory:');
  const sha = 'b'.repeat(40);
  const at = new Date().toISOString();
  store.saveTask({ id: 'task', repoKey: 'repo', title: 'Fix endpoint', scope: 'Fix endpoint',
    mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Fix endpoint',
      allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'trusted_rule', ruleRef: 'test' } },
    state: status === 'running' ? 'verifying' : 'blocked', iteration: 1,
    priority: 0, baseRef: 'a'.repeat(40), createdAt: at, updatedAt: at });
  store.saveRun({ id: 'verify', taskId: 'task', iteration: 1, stage: 'verify', status: 'succeeded',
    priority: 0, attempt: 0, agentKind: 'qoder', commitSha: sha, createdAt: at });
  store.saveRun({ id: 'functional', taskId: 'task', iteration: 1, stage: 'functional_verify', status,
    priority: 0, attempt: 1, agentKind: 'qoder', commitSha: sha, sessionId: 'session',
    createdAt: new Date(Date.parse(at) + 1000).toISOString() });
  return { store, sha, coordinator: createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['repo']) };
}

test('interrupted functional verification requires approval before review', async () => {
  const { store, sha, coordinator } = interruptedFunctional();
  try {
    coordinator.onWorkerFailure('functional', 'Run exceeded configured time budget', 'pause');
    const request = store.getRecord('functional-review-functional');
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.getRun('functional')?.status, 'paused');
    assert.equal(request?.kind, 'approval_request');
    assert.equal(request?.status, 'open');
    assert.throws(() => store.saveApprovalRequest({ kind: 'functional_review', id: 'wrong-sha',
      taskId: 'task', runId: 'functional', iteration: 1, sourceSha: 'c'.repeat(40),
      policyVersion: 'p1', reason: 'Bypass' }), /does not match/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='approval_request' AND status='open'").get()?.n, 1);
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: request!.id, actor: { kind: 'human', id: 'reviewer' },
        decision: 'approve', at: new Date().toISOString(), idempotencyKey: 'approve-review' } } });
    assert.equal(store.getTask('task')?.state, 'reviewing');
    assert.equal(store.getRecord(request!.id)?.kind, 'approval_request');
    assert.equal(store.getRecord(request!.id)?.status, 'approved');
    assert.equal(store.db.prepare("SELECT json_extract(payload_json,'$.action') AS action FROM task_record WHERE kind='approval'").get()?.action,
      'review');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='approval_request' AND status='open'").get()?.n, 0);
    const review = store.db.prepare("SELECT id FROM run WHERE task_id='task' AND stage='review'").get();
    assert.equal(store.getRun(String(review?.id))?.commitSha, sha);
  } finally { store.close(); }
});

test('rejected functional review approval stays visible and can retry functional verification', async () => {
  const { store, coordinator } = interruptedFunctional();
  try {
    coordinator.onWorkerFailure('functional', 'Timed out', 'pause');
    await coordinator.onSignal({ kind: 'human_response', response: { kind: 'approval_decision',
      value: { requestId: 'functional-review-functional', actor: { kind: 'human', id: 'reviewer' },
        decision: 'reject', at: new Date().toISOString(), idempotencyKey: 'reject-review' } } });
    assert.equal(store.getRecord('functional-review-functional')?.status, 'rejected');
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='review'").get()?.n, 0);
    const version = Number(store.db.prepare("SELECT version FROM task WHERE id='task'").get()?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'retry', taskId: 'task',
      expectedVersion: version, idempotencyKey: 'retry-functional-after-rejection', reason: 'Try again' });
    assert.equal(store.db.prepare("SELECT stage FROM run WHERE task_id='task' ORDER BY rowid DESC LIMIT 1").get()?.stage,
      'functional_verify');
  } finally { store.close(); }
});

test('failed functional Agent result also requests a decision before review', async () => {
  const { store, coordinator } = interruptedFunctional();
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'functional', status: 'failed', exitCode: 1,
        error: 'Agent exited without functional evidence' } });
    assert.equal(store.getRun('functional')?.status, 'failed');
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.getRecord('functional-review-functional')?.status, 'open');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='review'").get()?.n, 0);
  } finally { store.close(); }
});

test('functional review approval waits for confirmed process termination', async () => {
  const { store, coordinator } = interruptedFunctional();
  try {
    coordinator.onWorkerFailure('functional', 'Termination unknown', 'pause', true);
    assert.equal(store.getRecord('functional-review-functional'), undefined);
    await coordinator.onSignal({ kind: 'recovery', taskId: 'task', runId: 'functional',
      observation: { kind: 'finished', sessionId: 'session', exitCode: -1 } });
    assert.equal(store.getRecord('functional-review-functional')?.status, 'open');
    assert.equal(store.getTask('task')?.state, 'waiting_human');
  } finally { store.close(); }
});

test('manual termination confirmation opens the functional review approval', async () => {
  const { store, coordinator } = interruptedFunctional();
  try {
    coordinator.onWorkerFailure('functional', 'Termination unknown', 'pause', true);
    const version = Number(store.db.prepare("SELECT version FROM task WHERE id='task'").get()?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'confirm_termination', taskId: 'task',
      expectedVersion: version, idempotencyKey: 'confirm-functional-termination',
      reason: 'The local Agent process has stopped' });
    assert.equal(store.getRecord('functional-review-functional')?.status, 'open');
    assert.equal(store.getTask('task')?.state, 'waiting_human');
  } finally { store.close(); }
});

test('startup can offer approval for an existing paused functional verification', () => {
  const { store, coordinator } = interruptedFunctional('paused');
  try {
    coordinator.offerFunctionalReview('functional', 'Run exceeded configured time budget');
    coordinator.offerFunctionalReview('functional', 'Duplicate startup reconciliation');
    assert.equal(store.getRecord('functional-review-functional')?.status, 'open');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='approval_request'").get()?.n, 1);
  } finally { store.close(); }
});
