import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from '../src/agent/kernel/coordinator.js';
import { resolveReview } from '../src/authorization/policy/config.js';
import { setPolicyAuditSink } from '../src/authorization/policy/evaluate.js';

setPolicyAuditSink(() => {});

const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const finder = { find: () => ({ candidates: [], complete: true }) };

function fixture(review: Record<string, unknown>, verificationConfigured = true,
  developmentChecksRequired = verificationConfigured) {
  const store = new SqliteStore(':memory:');
  const at = new Date().toISOString();
  store.saveTask({ id: 'task', repoKey: 'repo', title: 'Develop', scope: 'Develop',
    mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Develop',
      allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'trusted_rule', ruleRef: 'rule' } },
    state: 'developing', iteration: 1, priority: 0, baseRef: base, createdAt: at, updatedAt: at });
  store.saveRun({ id: 'run', taskId: 'task', iteration: 1, stage: 'develop', status: 'running',
    priority: 0, attempt: 1, agentKind: 'qoder', commitSha: base, createdAt: at });
  const coordinator = createKernelCoordinator(store, {}, 'p1', 'rule', 'qoder', ['repo'], finder,
    undefined, {}, resolveReview(review, 'p1'), () => verificationConfigured, () => developmentChecksRequired);
  return { store, coordinator };
}

test('missing verification waits for manual delivery approval without queuing verify', async () => {
  const { store, coordinator } = fixture({ mode: 'warn' }, false);
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: { ...development(['src/a.ts']), checks: [] } } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='verify'").get()?.n, 0);
    const request = JSON.parse(String(store.db.prepare(
      "SELECT payload_json FROM task_record WHERE kind='approval_request' AND status='open'").get()?.payload_json));
    assert.equal(request.request.kind, 'manual_delivery');
    await coordinator.onSignal({ kind: 'human_response', taskId: 'task',
      response: { kind: 'approval_decision', value: { requestId: request.request.id,
        actor: { kind: 'human', id: 'owner' }, decision: 'approve',
        at: new Date().toISOString(), idempotencyKey: 'manual-delivery-approval' } } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='verify'").get()?.n, 0);
    assert.equal(store.getRecord(request.request.id)?.status, 'approved');
  } finally { store.close(); }
});

test('group verification may follow development without per-repository checks', async () => {
  const { store, coordinator } = fixture({ mode: 'warn' }, true, false);
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: { ...development(['src/a.ts']), checks: [] } } });
    assert.equal(store.getTask('task')?.state, 'verifying');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='verify'").get()?.n, 1);
  } finally { store.close(); }
});

test('verified review waits for manual delivery approval when external delivery is unconfigured', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const at = new Date().toISOString();
    store.saveTask({ id: 'task', repoKey: 'repo', title: 'Develop', scope: 'Develop',
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Develop',
        allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
        authority: { kind: 'trusted_rule', ruleRef: 'rule' } },
      state: 'reviewing', iteration: 1, priority: 0, baseRef: base, createdAt: at, updatedAt: at });
    store.saveRun({ id: 'develop', taskId: 'task', iteration: 1, stage: 'develop', status: 'succeeded',
      priority: 0, attempt: 1, commitSha: commit, createdAt: at });
    store.saveRun({ id: 'review', taskId: 'task', iteration: 1, stage: 'review', status: 'running',
      priority: 0, attempt: 1, commitSha: commit, createdAt: at });
    const coordinator = createKernelCoordinator(store, {}, 'p1', 'rule', 'qoder', ['repo'], finder,
      undefined, {}, resolveReview({ mode: 'warn' }, 'p1'), () => true, () => false, () => false);
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'review', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        review: { subjectSha: commit, verdict: 'pass', findings: [] } } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    const request = JSON.parse(String(store.db.prepare(
      "SELECT payload_json FROM task_record WHERE kind='approval_request' AND status='open'").get()?.payload_json));
    assert.equal(request.request.kind, 'manual_delivery');
    assert.equal(request.request.verificationSkipped, false);
    await coordinator.onSignal({ kind: 'human_response', taskId: 'task',
      response: { kind: 'approval_decision', value: { requestId: request.request.id,
        actor: { kind: 'human', id: 'owner' }, decision: 'approve', at, idempotencyKey: 'review-manual' } } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
  } finally { store.close(); }
});

test('manual delivery approval cannot be created for a running development Run', () => {
  const { store } = fixture({ mode: 'warn' }, false);
  try {
    store.saveTransition('task', 'waiting_human', 'handoff', new Date().toISOString(), 'handoff',
      { kind: 'system', id: 'test' });
    assert.throws(() => store.saveApprovalRequest({ kind: 'manual_delivery', id: 'manual', taskId: 'task',
      iteration: 1, sourceSha: base, policyVersion: 'p1', reason: 'manual' }), /does not match/);
  } finally { store.close(); }
});

test('policy approval cannot bypass failed development evidence', async () => {
  const { store, coordinator } = fixture({ mode: 'enforce', limits: { maxFiles: 2,
    maxChangedLines: 2000 } }, false);
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: { ...development(['src/a.ts', 'src/b.ts', 'src/c.ts']),
          postCheckVerified: false, checks: [] } } });
    assert.equal(store.getTask('task')?.state, 'blocked');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='approval_request'").get()?.n, 0);
  } finally { store.close(); }
});

function development(paths: string[]) {
  return { baseSha: base, commitSha: commit, diffRef: 'diff', changedPaths: paths,
    postCheckVerified: true, checks: [{ command: 'npm', args: ['test'], timeoutMs: 1000,
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), result: 'passed' as const,
      exitCode: 0, logRef: 'log', terminationConfirmed: true }] };
}

test('develop-complete 在 enforce 下拦截超限变更，任务转 waiting_human', async () => {
  setPolicyAuditSink(() => {});
  const { store, coordinator } = fixture({ mode: 'enforce', limits: { maxFiles: 2, maxChangedLines: 2000 } });
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: development(['src/a.ts', 'src/b.ts', 'src/c.ts']) } });
    assert.equal(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.getRun('run')?.status, 'succeeded');
    const request = store.db.prepare("SELECT payload_json FROM task_record WHERE kind='approval_request' AND status='open'").get();
    assert.ok(request);
    assert.equal(JSON.parse(String(request?.payload_json)).request.kind, 'continue');
  } finally { setPolicyAuditSink(() => {}); store.close(); }
});

test('策略审批通过后继续验证并排队 verify', async () => {
  setPolicyAuditSink(() => {});
  const { store, coordinator } = fixture({ mode: 'enforce', limits: { maxFiles: 2, maxChangedLines: 2000 } });
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: development(['src/a.ts', 'src/b.ts', 'src/c.ts']) } });
    const request = JSON.parse(String(store.db.prepare(
      "SELECT payload_json FROM task_record WHERE kind='approval_request' AND status='open'").get()?.payload_json));
    await coordinator.onSignal({ kind: 'human_response', taskId: 'task',
      response: { kind: 'approval_decision', value: { requestId: request.request.id,
        actor: { kind: 'human', id: 'owner' }, decision: 'approve',
        at: new Date().toISOString(), idempotencyKey: 'approve-1' } } });
    assert.equal(store.getTask('task')?.state, 'verifying');
    const developmentRecord = store.db.prepare(
      "SELECT payload_json FROM task_record WHERE kind='development'").get();
    assert.ok(developmentRecord);
    assert.equal(JSON.parse(String(developmentRecord?.payload_json)).commitSha, commit);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='check'").get()?.n, 1);
    const verify = store.db.prepare("SELECT status, commit_sha FROM run WHERE stage='verify'").get();
    assert.equal(verify?.status, 'queued');
    assert.equal(verify?.commit_sha, commit);
  } finally { setPolicyAuditSink(() => {}); store.close(); }
});

test('develop-complete 在 warn 下记录警告但不拦截', async () => {
  setPolicyAuditSink(() => {});
  const { store, coordinator } = fixture({ mode: 'warn', limits: { maxFiles: 2, maxChangedLines: 2000 } });
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: development(['src/a.ts', 'src/b.ts', 'src/c.ts']) } });
    assert.notEqual(store.getTask('task')?.state, 'waiting_human');
    const warning = store.db.prepare("SELECT payload_json FROM task_record WHERE kind='policy_warning'").get();
    assert.ok(warning);
    assert.equal(JSON.parse(String(warning?.payload_json)).gate, 'develop-complete');
  } finally { setPolicyAuditSink(() => {}); store.close(); }
});

test('develop-complete 在 shadow 下不拦截，任务继续进入验证', async () => {
  setPolicyAuditSink(() => {});
  const { store, coordinator } = fixture({ mode: 'shadow', limits: { maxFiles: 2, maxChangedLines: 2000 } });
  try {
    await coordinator.onSignal({ kind: 'agent_event', taskId: 'task',
      event: { kind: 'result', runId: 'run', status: 'succeeded', exitCode: 0, resultRef: 'ref',
        development: development(['src/a.ts', 'src/b.ts', 'src/c.ts']) } });
    assert.notEqual(store.getTask('task')?.state, 'waiting_human');
    assert.equal(store.getRun('run')?.status, 'succeeded');
  } finally { setPolicyAuditSink(() => {}); store.close(); }
});
