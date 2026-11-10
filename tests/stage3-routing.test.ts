import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createEventIngress } from '../src/event/ingress.js';
import { createEventLoop, createKernelCoordinator } from './kernel-fixture.js';
import { createEventLoop as createEventLoopCore } from '../src/agent/kernel/event-loop.js';
import { planRoute } from '../src/agent/kernel/task-loop.js';
import { createTaskCandidateFinder } from '../src/agent/router/candidate-finder.js';
import { investigationMandate } from '../src/authorization/model.js';
import { createWorkerManager } from '../src/agent/worker/manager.js';
import { decideAgentEvent } from '../src/agent/task/workflow.js';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceId = 'local-fixture';
const event = { sourceId, externalId: 'bug-1', revision: '1', kind: 'bug', title: '调查样本', body: '样本',
  objectKey: 'issue-1', repoKey: 'agent-platform', attachments: [], metaData: {} };

function approveNewImageTask(store: SqliteStore, eventId: string): void {
  assert.equal(store.get(eventId)?.status, 'needs_human');
  createKernelCoordinator(store, {}, 'p1', 'fixture', 'qoder', ['agent-platform']).resolveHumanRoute({ choice: 'new_task', eventId, repoKey: 'agent-platform',
    actor: { kind: 'human', id: 'owner' }, at: new Date().toISOString(),
    idempotencyKey: `route-${eventId}`, reason: 'Image reviewed for routing' });
}

test('event loop atomically creates investigation task, history, subscription and one Run', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const ingress = createEventIngress(store, { [sourceId]: [] });
    const first = await ingress.accept(event);
    const loop = createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule', 'qoder');
    assert.equal(loop.processOne(), true);
    assert.equal(loop.processOne(), false);
    const taskRow = store.db.prepare('SELECT id,state FROM task').get();
    assert.equal(taskRow?.state, 'queued');
    const taskId = String(taskRow?.id);
    assert.equal(store.get(first.eventId)?.status, 'done');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM run').get()?.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='state_change'").get()?.n, 2);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM subscription').get()?.n, 1);
    assert.deepEqual(await ingress.accept(event), { eventId: first.eventId, duplicate: true });
    const followup = await ingress.accept({ ...event, externalId: 'bug-2', revision: '2' });
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(followup.eventId)?.status, 'done');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='event_link' AND task_id=?").get(taskId)?.n, 2);
  } finally { store.close(); }
});

test('event loop uses the injected candidate finder', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const incoming = store.accept(event);
    let searched = false;
    const finder = { find() { searched = true; return { candidates: [{ taskId: 'candidate-1',
      evidence: [{ kind: 'fixture', sourceRef: 'candidate-1', details: 'Needs review' }] }], complete: true }; } };
    assert.equal(createEventLoopCore(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule',
      'qoder', finder).processOne(), true);
    assert.equal(searched, true);
    assert.equal(store.get(incoming.eventId)?.status, 'needs_human');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 0);
  } finally { store.close(); }
});

test('route commit rejects a forged lifecycle plan without persisting a Task or Run', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const { eventId } = store.accept(event);
    const at = new Date().toISOString();
    const claimed = store.claimEvent(at, new Date(Date.now() + 60_000).toISOString())!;
    const decision = { kind: 'new_task' as const, repoKey: 'agent-platform', contextTaskIds: [],
      mandate: investigationMandate(eventId, 'agent-platform', event.title, 'p1', 'test-rule') };
    const plan = planRoute(claimed, decision, undefined, false, 'qoder', at);
    assert.ok(plan.task);
    assert.throws(() => store.commitRoute(eventId, { ...plan,
      task: { ...plan.task!, mandate: { ...plan.task!.mandate, scope: 'forged scope' } } }, at));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM run').get()?.n, 0);
  } finally { store.close(); }
});

test('unmapped source waits for human and conflicting handles never create a Task', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const first = store.accept(event);
    const loop = createEventLoop(store, {}, 'p1', 'fixture-rule', 'qoder');
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(first.eventId)?.status, 'needs_human');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 0);
  } finally { store.close(); }
});

test('similar Chinese Bug text becomes an auditable candidate before another Task is created', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const first = store.accept({ ...event, title: '配置时间后任务数量异常增加',
      body: '配置时间后进行中的任务数据量增加' });
    const loop = createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule', 'qoder');
    assert.equal(loop.processOne(), true);
    const firstTaskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const second = store.accept({ ...event, externalId: 'bug-2', objectKey: 'issue-2',
      title: '设置时间后任务数量异常增加', body: '配置时间后进行中的任务数据量增加了' });
    assert.equal(loop.processOne(), true);
    const pending = store.get(second.eventId)!;
    assert.equal(pending.status, 'needs_human');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 1);
    const routing = pending.routingData as { candidates: Array<{ taskId: string; evidence: Array<{ kind: string; details: string }> }> };
    assert.equal(routing.candidates[0]?.taskId, firstTaskId);
    assert.equal(routing.candidates[0]?.evidence[0]?.kind, 'text_similarity');
    assert.match(routing.candidates[0]!.evidence[0]!.details, /Dice score/);
    const decided = createKernelCoordinator(store, {}, 'p1', 'fixture', 'qoder', ['agent-platform']).resolveHumanRoute({ choice: 'existing_task', eventId: second.eventId, taskId: firstTaskId,
      actor: { kind: 'human', id: 'owner' }, at: new Date().toISOString(),
      idempotencyKey: 'similar-route', reason: 'Same issue confirmed' });
    assert.equal(decided, firstTaskId);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 1);
    assert.equal(store.get(first.eventId)?.status, 'done');
  } finally { store.close(); }
});

test('identical short Bug text becomes a candidate and never silently creates a second Task', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const loop = createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule', 'qoder');
    store.accept({ ...event, title: '闪退', body: '闪退' });
    assert.equal(loop.processOne(), true);
    const firstTaskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const second = store.accept({ ...event, externalId: 'bug-2', objectKey: 'issue-2',
      title: '闪退', body: '闪退' });
    const search = createTaskCandidateFinder(store).find(store.get(second.eventId)!, 'agent-platform');
    assert.equal(search.complete, false);
    assert.equal(search.candidates[0]?.taskId, firstTaskId);
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(second.eventId)?.status, 'needs_human');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 1);
  } finally { store.close(); }
});

test('a Task without its original event body makes candidate coverage incomplete', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const at = new Date().toISOString();
    store.saveTask({ id: 'orphan-task', repoKey: 'agent-platform', title: '历史任务标题内容较长',
      scope: '历史任务标题内容较长',
      mandate: investigationMandate('missing-origin', 'agent-platform', '历史任务标题内容较长', 'p1', 'fixture-rule'),
      state: 'queued', iteration: 1, priority: 0, createdAt: at, updatedAt: at });
    const incoming = store.accept({ ...event, title: '支付网关校验失败', body: '请求返回用户身份验证错误' });
    const search = createTaskCandidateFinder(store).find(store.get(incoming.eventId)!, 'agent-platform');
    assert.deepEqual(search.candidates, []);
    assert.equal(search.complete, false);
    assert.equal(createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule', 'qoder').processOne(), true);
    assert.equal(store.get(incoming.eventId)?.status, 'needs_human');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 1);
  } finally { store.close(); }
});

test('candidate search stays in the trusted repository and holds an incomplete search for review', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const at = new Date().toISOString();
    const task = (id: string, repoKey: string) => ({ id, repoKey, title: '配置时间后任务数量异常增加',
      scope: '配置时间后进行中的任务数据量增加',
      mandate: { sourceEventId: `origin-${id}`, repoKey, goal: 'investigate',
        allowedActions: ['investigate' as const], maxAutoRisk: 'low' as const, policyVersion: 'p1',
        authority: { kind: 'trusted_rule' as const, ruleRef: 'fixture' } },
      state: 'queued' as const, iteration: 1, priority: 0, createdAt: at, updatedAt: at });
    store.saveTask(task('foreign-task', 'other-repo'));
    const first = store.accept({ ...event, title: '配置时间后任务数量异常增加',
      body: '配置时间后进行中的任务数据量增加' });
    const loop = createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule', 'qoder');
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(first.eventId)?.status, 'done');
    for (let index = 0; index < 501; index++) store.saveTask(task(`unrelated-${index}`, 'agent-platform'));
    const second = store.accept({ ...event, externalId: 'bug-2', objectKey: 'issue-2',
      title: '支付令牌鉴权失败', body: '支付接口报告权限错误' });
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(second.eventId)?.status, 'needs_human');
    assert.match((store.get(second.eventId)?.routingData as { reason: string }).reason, /incomplete/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 503);
  } finally { store.close(); }
});

test('Run claim reserves one configured slot for human resumption and leaves verify queued', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    store.accept({ ...event, externalId: 'bug-2', objectKey: 'issue-2',
      title: '支付网关令牌校验失败', body: '请求返回鉴权错误' });
    const loop = createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture-rule', 'qoder');
    assert.equal(loop.processOne(), true);
    assert.equal(loop.processOne(), true);
    const limits = { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 };
    const at = new Date().toISOString();
    const lease = new Date(Date.now() + 60_000).toISOString();
    const first = store.claimRun('worker-1', at, lease, limits, ['qoder'])!;
    assert.equal(first.status, 'running');
    assert.equal(store.claimRun('worker-2', at, lease, limits, ['qoder']), undefined);
    const queuedId = String(store.db.prepare("SELECT id FROM run WHERE status='queued'").get()?.id);
    const queued = store.getRun(queuedId)!;
    store.replaceRun({ ...queued, queueClass: 'human_resume' }, 'queued');
    const resumed = store.claimRun('worker-2', at, lease, limits, ['qoder'])!;
    assert.equal(resumed.queueClass, 'human_resume');
    assert.equal(store.claimRun('worker-3', at, lease, limits, ['qoder']), undefined);
    store.saveRun({ id: 'verify-run', taskId: first.taskId, iteration: 1, stage: 'verify', status: 'queued',
      priority: 99, attempt: 0, agentKind: 'qoder', createdAt: at });
    assert.equal(store.claimRun('worker-3', at, lease, { ...limits, maxConcurrentRuns: 3 }, ['qoder']), undefined);
  } finally { store.close(); }
});

test('worker fails closed before creating a workspace when Qoder or isolation is unverified', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    let prepared = false;
    const manager = createWorkerManager({ store, coordinator,
      runners: { qoder: { capabilities: () => ({ start: 'unverified' }),
        async start() { throw new Error('Must not start'); }, async resume() { return { kind: 'unsupported' }; },
        async send() { return { kind: 'unsupported' }; }, async read() { return { kind: 'unknown', runId: 'r' }; },
        async cancel() { return { kind: 'unsupported' }; } } }, enabledAgents: [],
      workspace: { async prepare() { prepared = true; throw new Error('Must not prepare'); } },
      skills: { async load() { throw new Error('Must not load'); } },
      boundary: { async attest() { throw new Error('Must not attest'); } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 1000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(prepared, false);
    assert.equal(store.db.prepare('SELECT state FROM task').get()?.state, 'waiting_human');
    assert.equal(store.db.prepare('SELECT status FROM run').get()?.status, 'paused');
  } finally { store.close(); }
});

test('successful investigation requests SHA-bound edit scope and queues no develop Run', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const sha = 'a'.repeat(40);
    store.setTaskBaseRef(taskId, sha);
    const now = new Date();
    const claimed = store.claimRun('worker', now.toISOString(), new Date(now.getTime() + 60_000).toISOString(),
      { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 }, ['qoder'])!;
    store.setEventLinkStatus(taskId, store.getTask(taskId)!.originEventId!, 'pending', 'delivered');
    await coordinator.onSignal({ kind: 'agent_event', taskId,
      event: { kind: 'result', runId: claimed.id, status: 'succeeded', exitCode: 0, resultRef: 'report-ref' } });
    assert.equal(store.getTask(taskId)?.state, 'waiting_human');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='develop'").get()?.n, 0);
    const request = store.getRecord(`scope-${claimed.id}`);
    assert.equal(request?.kind, 'approval_request');
    if (request?.kind === 'approval_request') {
      assert.equal((request.request as { sourceSha: string }).sourceSha, sha);
      assert.equal((request.request as { proposedMandate: { maxAutoRisk: string } }).proposedMandate.maxAutoRisk, 'high');
    }
  } finally { store.close(); }
});

test('human route is auditable and handback cannot loop through the same Task', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const incoming = store.accept(event);
    createEventLoop(store, {}, 'p1', 'fixture', 'qoder').processOne();
    assert.equal(store.get(incoming.eventId)?.status, 'needs_human');
    const decision = { choice: 'new_task' as const, eventId: incoming.eventId, repoKey: 'agent-platform',
      actor: { kind: 'human' as const, id: 'local-owner' }, at: new Date().toISOString(),
      idempotencyKey: 'route-key', reason: 'Repository confirmed' };
    const taskId = createKernelCoordinator(store, {}, 'p1', 'fixture', 'qoder', ['agent-platform']).resolveHumanRoute(decision)!;
    assert.equal(createKernelCoordinator(store, {}, 'p1', 'fixture', 'qoder', ['agent-platform']).resolveHumanRoute(decision), taskId);
    assert.throws(() => store.setEventLinkStatus(taskId, incoming.eventId, 'pending', 'handled'));
    store.handbackEvent(taskId, incoming.eventId, 'Out of scope');
    assert.equal(store.get(incoming.eventId)?.status, 'pending');
    assert.throws(() => store.handbackEvent(taskId, incoming.eventId, 'again'));
    createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder').processOne();
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 2);
  } finally { store.close(); }
});

test('human review creates a same-repository investigation Task linked to a closed candidate', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const at = new Date().toISOString();
    const historical = (id: string, repoKey: string) => ({ id, repoKey,
      title: '配置时间后任务数量异常增加', scope: '配置时间后任务数量异常增加',
      mandate: investigationMandate(`origin-${id}`, repoKey, '调查历史问题', 'p1', 'fixture'),
      state: 'closed' as const, iteration: 1, priority: 0, createdAt: at, updatedAt: at });
    store.saveTask(historical('closed-task', 'agent-platform'));
    store.saveTask(historical('foreign-task', 'other-repo'));
    const loop = createEventLoop(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder');
    const incoming = store.accept({ ...event, title: '配置时间后任务数量异常增加',
      body: '配置时间后进行中的数据量增加' });
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(incoming.eventId)?.status, 'needs_human');
    const candidates = (store.get(incoming.eventId)?.routingData as { candidates: Array<{ taskId: string }> }).candidates;
    assert.equal(candidates[0]?.taskId, 'closed-task');
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    const decision = { choice: 'new_task' as const, eventId: incoming.eventId, repoKey: 'agent-platform',
      parentTaskId: 'closed-task', actor: { kind: 'human' as const, id: 'owner' }, at,
      idempotencyKey: 'related-review', reason: 'Related to the closed issue' };
    const taskId = coordinator.resolveHumanRoute(decision)!;
    assert.equal(store.getTask(taskId)?.parentTaskId, 'closed-task');
    assert.equal(store.getTask(taskId)?.mandate.sourceEventId, incoming.eventId);
    assert.deepEqual(store.getTask(taskId)?.mandate.allowedActions, ['investigate']);
    assert.equal(store.getTask(taskId)?.state, 'queued');
    assert.equal(coordinator.resolveHumanRoute(decision), taskId);
    assert.throws(() => coordinator.resolveHumanRoute({ ...decision, parentTaskId: 'foreign-task' }));
    const next = store.accept({ ...event, externalId: 'unrelated', objectKey: 'unrelated-issue',
      title: '支付网关鉴权失败', body: '请求返回身份校验错误' });
    assert.equal(loop.processOne(), true);
    assert.equal(store.get(next.eventId)?.status, 'needs_human');
    const other = { ...decision, eventId: next.eventId, idempotencyKey: 'cross-repo-review' };
    assert.throws(() => coordinator.resolveHumanRoute({ ...other, parentTaskId: 'foreign-task' }));
    assert.throws(() => coordinator.resolveHumanRoute({ ...other, parentTaskId: 'missing-task' }));
    assert.equal(store.get(next.eventId)?.status, 'needs_human');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 3);
  } finally { store.close(); }
});

test('verified runner receives linked input once and only its explicit receipt handles it', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const sent: string[] = [];
    let wrongFinishedRun = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported', send: 'supported' }),
        async start() { return { sessionId: 'session-1' }; }, async resume() { return { kind: 'unsupported' }; },
        async send(_session, input) { if (input.kind === 'source_followup') sent.push(input.eventId);
          return { kind: 'accepted' }; },
        async read() { return wrongFinishedRun ? { kind: 'finished', runId: 'different-run', exitCode: 0,
          resultRef: 'wrong-result' } : { kind: 'running',
          runId: String(store.db.prepare("SELECT id FROM run WHERE status='running'").get()?.id) }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/isolated-test', baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId,
        repoKey: value.repoKey, workspacePath: value.workspacePath,
        mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(store.getRun(String(store.db.prepare('SELECT id FROM run').get()?.id))?.execution?.adapterVersion, 'test');
    const followup = store.accept({ ...event, externalId: 'followup', revision: '2' });
    coordinator.processPending();
    await manager.poll();
    assert.deepEqual(sent, [followup.eventId]);
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE event_id=? AND kind='event_link'").get(followup.eventId)?.status, 'delivered');
    const runId = String(store.db.prepare('SELECT id FROM run').get()?.id);
    await coordinator.onSignal({ kind: 'agent_event', taskId,
      event: { kind: 'input_handled', runId, eventId: followup.eventId } });
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE event_id=? AND kind='event_link'").get(followup.eventId)?.status, 'handled');
    wrongFinishedRun = true;
    assert.equal(await manager.poll(), 0);
    assert.equal(store.getRun(runId)?.status, 'paused');
    assert.equal(store.getRun(runId)?.processTerminationUnconfirmed, true);
    assert.equal(store.getRun(runId)?.resultRef, undefined);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='agent_report' AND status='succeeded'").get()?.n, 0);
  } finally { store.close(); }
});

test('confirmed Qoder startup exit does not block unrelated queued Runs', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' },
      'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { throw Object.assign(new Error('Authentication failed'), { terminationConfirmed: true }); },
        async read() { return { kind: 'unknown', runId: 'none' }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/confirmed-startup-exit',
        baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId,
        repoKey: value.repoKey, workspacePath: value.workspacePath,
        mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    const run = store.getRun(String(store.db.prepare('SELECT id FROM run').get()?.id));
    assert.equal(run?.status, 'paused');
    assert.equal(run?.processTerminationUnconfirmed, false);
  } finally { store.close(); }
});

test('a question keeps its slot until the same process has durable termination evidence', async () => {
  for (const confirmed of [true, false]) {
    const store = new SqliteStore(':memory:', { [sourceId]: [] });
    try {
      store.registerSource(sourceId, 'fixture', 'fixture', true);
      store.accept(event);
      const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
      coordinator.processPending();
      const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
      const runId = String(store.db.prepare('SELECT id FROM run').get()?.id);
      let finished = false;
      let launches = 0;
      const makeManager = () => createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
        runners: { qoder: { capabilities: () => ({ start: 'supported', resume: 'unsupported', send: 'unsupported' }),
          async start() { launches++; return { sessionId: `session-${launches}` }; },
          async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
          async read() { return finished ? { kind: 'finished', runId, exitCode: 0 }
            : { kind: 'running', runId }; },
          async readDurable() { return confirmed ? { kind: 'finished', runId, exitCode: 0 }
            : { kind: 'unknown', runId }; },
          async cancel() { return { kind: 'accepted' }; } } },
        workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/question-slot',
          baseSha: 'a'.repeat(40) }; } },
        skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
        boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
          workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
        skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
        limits: { maxConcurrentRuns: 1, perRepoConcurrentRuns: 1, perAgentConcurrentRuns: 1, reservedHumanResume: 0 } });
      const manager = makeManager();
      assert.equal(await manager.tick(), true);
      const current = store.getRun(runId)!;
      store.saveRun({ id: `followup-${confirmed}`, taskId, iteration: 1, stage: 'investigate',
        status: 'queued', requestKey: `followup-${confirmed}`, priority: 0, attempt: 0,
        agentKind: 'qoder', createdAt: new Date().toISOString() });
      await coordinator.onSignal({ kind: 'agent_event', taskId,
        event: { kind: 'question', runId, questionId: 'question-slot', prompt: 'Clarify?' } });
      assert.equal(store.getRun(runId)?.status, 'running');
      assert.equal(store.getTask(taskId)?.state, 'investigating');
      await assert.rejects(coordinator.onSignal({ kind: 'human_response', taskId,
        response: { kind: 'answer', value: { questionId: 'question-slot', content: 'Yes',
          idempotencyKey: 'answer-before-proof', actor: { kind: 'human', id: 'owner' } } } }));
      assert.equal(await manager.tick(), false);
      assert.equal(await manager.poll(), 0);
      assert.equal(store.getRun(runId)?.status, 'running');
      finished = true;
      const resumedManager = confirmed ? makeManager() : manager;
      if (confirmed) assert.equal(await resumedManager.recover(), 1);
      else await resumedManager.poll();
      assert.equal(store.getRun(runId)?.status, confirmed ? 'waiting_human' : 'paused');
      assert.equal(store.getRun(runId)?.processTerminationUnconfirmed, confirmed ? undefined : true);
      assert.equal(await resumedManager.tick(), false);
      assert.equal(launches, 1);
      if (confirmed) {
        await coordinator.onSignal({ kind: 'human_response', taskId,
          response: { kind: 'answer', value: { questionId: 'question-slot', content: 'Yes',
            idempotencyKey: 'answer-after-proof', actor: { kind: 'human', id: 'owner' } } } });
        assert.equal(store.getRun(runId)?.status, 'queued');
        assert.equal(await resumedManager.tick(), true);
        assert.equal(launches, 2);
      }
      assert.equal(current.sessionId, 'session-1');
    } finally { store.close(); }
  }
});

for (const durableFinished of [true, false]) test(`restarted Run recovery ${durableFinished ? 'uses durable completion' : 'waits when completion is unknown'}`, async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const runId = String(store.db.prepare('SELECT id FROM run').get()?.id);
    const queued = store.getRun(runId)!;
    store.setTaskBaseRef(queued.taskId, 'a'.repeat(40));
    store.replaceRun({ ...queued, status: 'running', sessionId: 'old-session', workerId: 'old-worker',
      leaseUntil: '2099-01-01T00:00:00.000Z' }, 'queued');
    store.accept({ ...event, externalId: 'bug-2', objectKey: 'issue-2',
      title: '支付网关令牌校验失败', body: '请求返回鉴权错误' });
    coordinator.processPending();
    let durableCalls = 0;
    let completionKnown = durableFinished;
    const recoveryKinds: string[] = [];
    const handleSignal = coordinator.onSignal.bind(coordinator);
    coordinator.onSignal = async signal => {
      if (signal.kind === 'recovery') recoveryKinds.push(signal.observation?.kind ?? 'missing');
      await handleSignal(signal);
    };
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { throw new Error('Recovery must not launch'); },
        async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
        async read() { throw new Error('Recovery must use durable evidence'); },
        async readDurable(id, session) { durableCalls++; assert.deepEqual([id, session], [runId, 'old-session']);
          if (!completionKnown) throw new Error('Durable status unavailable');
          return { kind: 'finished', runId, exitCode: 0, resultRef: '/trusted/result.json' }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { throw new Error('Recovery must not create a workspace'); } },
      skills: { async load() { throw new Error('Recovery must not load Skill'); } },
      boundary: { async attest() { throw new Error('Recovery must not attest'); } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.recover(), 1);
    assert.equal(durableCalls, 1);
    assert.deepEqual(recoveryKinds, [durableFinished ? 'finished' : 'unknown']);
    assert.equal(store.getRun(runId)?.status, durableFinished ? 'succeeded' : 'paused');
    assert.equal(store.getRun(runId)?.resultRef, durableFinished ? '/trusted/result.json' : undefined);
    assert.equal(store.getTask(queued.taskId)?.state, durableFinished ? 'investigating' : 'waiting_human');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE run_id=? AND kind='agent_report'").get(runId)?.n, 1);
    if (!durableFinished) {
      const now = new Date().toISOString();
      const limits = { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2,
        reservedHumanResume: 1 };
      assert.equal(store.getRun(runId)?.processTerminationUnconfirmed, true);
      assert.equal(store.claimRun('new-worker', now, now, limits, ['qoder']), undefined);
      completionKnown = true;
      assert.equal(await manager.recover(), 1);
      assert.deepEqual(recoveryKinds, ['unknown', 'finished']);
      assert.equal(store.getRun(runId)?.processTerminationUnconfirmed, false);
      assert.ok(store.claimRun('new-worker', now, now, limits, ['qoder']));
    }
  } finally { store.close(); }
});

test('recovery signal rejects a different Task or Session without changing the Run', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const runId = String(store.db.prepare('SELECT id FROM run').get()?.id);
    const queued = store.getRun(runId)!;
    store.replaceRun({ ...queued, status: 'running', sessionId: 'expected-session' }, 'queued');
    await assert.rejects(coordinator.onSignal({ kind: 'recovery', taskId: 'different-task', runId,
      observation: { kind: 'finished', sessionId: 'expected-session', exitCode: 0, resultRef: 'result' } }));
    await assert.rejects(coordinator.onSignal({ kind: 'recovery', taskId: queued.taskId, runId,
      observation: { kind: 'finished', sessionId: 'different-session', exitCode: 0, resultRef: 'result' } }));
    assert.equal(store.getRun(runId)?.status, 'running');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE run_id=? AND kind='agent_report'").get(runId)?.n, 0);
  } finally { store.close(); }
});

for (const scenario of ['confirmed', 'start-fails', 'unknown-end'] as const) test(`new Qoder Session handoff ${scenario}`, async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const incoming = store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const runId = String(store.db.prepare('SELECT id FROM run').get()?.id);
    const queued = store.getRun(runId)!;
    store.replaceRun({ ...queued, status: 'running', sessionId: 'old-session' }, 'queued');
    await coordinator.onSignal({ kind: 'agent_event', taskId,
      event: { kind: 'question', runId, questionId: 'question-1', prompt: 'Which behavior?' } });
    coordinator.onQuestionProcessEnded(runId, 'old-session');
    await coordinator.onSignal({ kind: 'human_response', taskId, response: { kind: 'answer', value: { questionId: 'question-1', content: 'Use the documented behavior',
      idempotencyKey: 'answer-1', actor: { kind: 'human', id: 'owner' } } } });
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported', resume: 'unsupported', send: 'unsupported' }),
        async start(request) {
          const facts = JSON.parse(request.input.kind === 'task' ? request.input.prompt : '{}');
          assert.equal(facts.answers[0].content, 'Use the documented behavior');
          assert.equal(facts.events[0].body, event.body);
          if (scenario === 'unknown-end') throw new Error('Unconfirmed old process started a new Session');
          if (scenario === 'start-fails') throw new Error('Input confirmation timed out');
          return { sessionId: 'new-session' };
        }, async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'unknown', runId }; },
        async readDurable(id, session) { assert.equal(id, runId); assert.equal(session, 'old-session');
          return scenario === 'unknown-end' ? { kind: 'unknown', runId }
            : { kind: 'finished', runId, exitCode: 0 }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/isolated-handoff', baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    const answer = store.getRecord(String(store.db.prepare("SELECT id FROM task_record WHERE kind='answer'").get()?.id));
    assert.equal(answer?.kind, 'answer');
    if (answer?.kind === 'answer') assert.equal(answer.status,
      scenario === 'confirmed' ? 'delivered' : scenario === 'start-fails' ? 'uncertain' : 'pending');
    assert.equal(store.getRun(runId)?.status, scenario === 'confirmed' ? 'running' : 'paused');
  } finally { store.close(); }
});

for (const summaryFails of [false, true]) test(`new Run ${summaryFails ? 'blocks an invalid prior conclusion' : 'receives the prior conclusion and reference'}`, async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const incoming = store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    const first = store.getRun(String(store.db.prepare('SELECT id FROM run').get()?.id))!;
    store.replaceRun({ ...first, status: 'succeeded', sessionId: 'old-session', resultRef: '/trusted/old.json',
      endedAt: new Date().toISOString() }, 'queued');
    store.saveRun({ ...first, id: 'next-run', status: 'queued', sessionId: undefined,
      resultRef: undefined, endedAt: undefined, requestKey: 'next-run', createdAt: new Date().toISOString() });
    let started = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start(request) { started = true;
          const facts = JSON.parse(request.input.kind === 'task' ? request.input.prompt : '{}');
          assert.deepEqual(facts.previousResults[0], { runId: first.id, resultRef: '/trusted/old.json',
            conclusion: { kind: 'unverified_agent_conclusion', text: 'The condition fails in module A.' } });
          return { sessionId: 'next-session' }; },
        async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'running', runId: 'next-run' }; },
        async resultSummary(runId, sessionId, resultRef) {
          assert.deepEqual([runId, sessionId, resultRef], [first.id, 'old-session', '/trusted/old.json']);
          if (summaryFails) throw new Error('Previous Qoder result is unavailable or mismatched');
          return 'The condition fails in module A.';
        }, async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/isolated-summary', baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(started, !summaryFails);
    assert.equal(store.getRun('next-run')?.status, summaryFails ? 'paused' : 'running');
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE event_id=? AND kind='event_link'").get(incoming.eventId)?.status,
      summaryFails ? 'pending' : 'delivered');
  } finally { store.close(); }
});

for (const summaryFails of [false, true]) test(`related investigation ${summaryFails ? 'blocks an invalid parent conclusion' : 'hands off verified parent facts without its Mandate'}`, async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    const at = new Date().toISOString();
    const baseSha = 'a'.repeat(40);
    const commitSha = 'b'.repeat(40);
    const mandate = investigationMandate('old-event', 'agent-platform', 'Old investigation', 'p1', 'fixture');
    store.saveTask({ id: 'old-task', repoKey: 'agent-platform', title: 'Old defect', scope: 'Old scope',
      mandate, state: 'closed', iteration: 2, priority: 0, baseRef: baseSha, createdAt: at, updatedAt: at });
    store.saveRun({ id: 'old-run', taskId: 'old-task', iteration: 2, stage: 'develop', status: 'succeeded',
      priority: 0, attempt: 1, agentKind: 'qoder', sessionId: 'old-session', resultRef: '/trusted/old.json',
      commitSha, createdAt: at, endedAt: at });
    store.saveRecord({ id: 'old-proof', taskId: 'old-task', runId: 'old-run', kind: 'development',
      baseSha, commitSha, diffRef: '/trusted/old.patch', postCheckVerified: true, at });
    store.saveTask({ id: 'new-task', repoKey: 'agent-platform', title: 'Related defect', scope: 'New scope',
      mandate: investigationMandate('new-event', 'agent-platform', 'New investigation', 'p1', 'fixture'),
      state: 'queued', iteration: 1, priority: 0, parentTaskId: 'old-task', createdAt: at, updatedAt: at });
    store.saveRun({ id: 'new-run', taskId: 'new-task', iteration: 1, stage: 'investigate', status: 'queued',
      priority: 0, attempt: 0, agentKind: 'qoder', createdAt: at });
    let started = false;
    const coordinator = createKernelCoordinator(store, {}, 'p1', 'fixture', 'qoder', ['agent-platform']);
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start(request) {
          started = true;
          const facts = JSON.parse(request.input.kind === 'task' ? request.input.prompt : '{}');
          assert.deepEqual(facts.parentTaskFacts, { taskId: 'old-task', state: 'closed', iteration: 2,
            title: 'Old defect', scope: 'Old scope', baseSha,
            previousResults: [{ runId: 'old-run', resultRef: '/trusted/old.json', commitSha,
              conclusion: { kind: 'unverified_agent_conclusion', text: 'The old issue was fixed in module A.' } }],
            developmentEvidence: [{ runId: 'old-run', baseSha, commitSha, diffRef: '/trusted/old.patch' }] });
          assert.equal(facts.parentTaskFacts.mandate, undefined);
          assert.deepEqual(request.mandate.allowedActions, ['investigate']);
          return { sessionId: 'new-session' };
        }, async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'running', runId: 'new-run' }; },
        async resultSummary(runId, sessionId, resultRef) {
          assert.deepEqual([runId, sessionId, resultRef], ['old-run', 'old-session', '/trusted/old.json']);
          if (summaryFails) throw new Error('Previous Qoder result is unavailable or mismatched');
          return 'The old issue was fixed in module A.';
        }, async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/related-clone', baseSha }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: baseSha, maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(started, !summaryFails);
    assert.equal(store.getRun('new-run')?.status, summaryFails ? 'paused' : 'running');
  } finally { store.close(); }
});

test('trusted image reader stages an image inside the Run clone before Qoder starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-image-'));
  const clone = join(root, 'clone');
  mkdirSync(join(clone, '.git'), { recursive: true });
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const incoming = store.accept({ ...event, attachments: [{ id: 'image-1', kind: 'image', sourceRef: 'opaque/image-1' }] });
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    approveNewImageTask(store, incoming.eventId);
    const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    let stagedPath = '';
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported', attachments: 'supported' }),
        async start(request) { stagedPath = request.attachmentPaths?.[0] ?? '';
          assert.ok(stagedPath.startsWith(realpathSync(join(clone, '.git', 'agent-input'))));
          assert.deepEqual(readFileSync(stagedPath), image);
          return { sessionId: 'image-session' }; }, async resume() { return { kind: 'unsupported' }; },
        async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'finished',
          runId: String(store.db.prepare("SELECT id FROM run WHERE status='running'").get()?.id),
          exitCode: 0, resultRef: 'image-report' }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: clone, baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate image' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      attachmentReaders: { [sourceId]: { async open(id, ref) {
        assert.equal(id, sourceId); assert.equal(ref.id, 'image-1');
        return new ReadableStream({ start(controller) { controller.enqueue(image); controller.close(); } });
      } } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE event_id=? AND kind='event_link'").get(incoming.eventId)?.status, 'delivered');
    assert.equal(await manager.poll(), 1);
    assert.equal(existsSync(stagedPath), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const limit of ['count', 'bytes'] as const) test(`image ${limit} limit stops a Run before Qoder starts`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-image-limit-'));
  const clone = join(root, 'clone');
  mkdirSync(join(clone, '.git'), { recursive: true });
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    const refs = Array.from({ length: limit === 'count' ? 9 : 3 }, (_, index) =>
      ({ id: `image-${index}`, kind: 'image' as const, sourceRef: `fixture/image-${index}` }));
    const incoming = store.accept({ ...event, attachments: refs });
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture', 'qoder', ['agent-platform']);
    coordinator.processPending();
    approveNewImageTask(store, incoming.eventId);
    const bytes = new Uint8Array(7 * 1024 * 1024);
    bytes.set(Buffer.from('89504e470d0a1a0a', 'hex'));
    let reads = 0;
    let starts = 0;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported', attachments: 'supported' }),
        async start() { starts++; return { sessionId: 'unexpected' }; },
        async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'unknown', runId: 'none' }; }, async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: clone, baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      attachmentReaders: { [sourceId]: { async open() { reads++;
        return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      } } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(starts, 0);
    assert.equal(reads, limit === 'count' ? 0 : 3);
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE event_id=? AND kind='event_link'").get(incoming.eventId)?.status, 'pending');
    assert.equal(existsSync(join(clone, '.git', 'agent-input')), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('develop cannot queue verify without matching commit, diff and passing checks', () => {
  const baseSha = 'a'.repeat(40);
  const task = { id: 't', repoKey: 'agent-platform', title: 'Bug', scope: 'Fix bug',
    mandate: { sourceEventId: 'e', repoKey: 'agent-platform', goal: 'Fix bug',
      allowedActions: ['investigate', 'edit'] as Array<'investigate' | 'edit'>, maxAutoRisk: 'low' as const,
      policyVersion: 'p1', authority: { kind: 'human_approval' as const, approvalRef: 'approval' } },
    state: 'developing' as const, iteration: 1, priority: 0, baseRef: baseSha,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const run = { id: 'r', taskId: 't', iteration: 1, stage: 'develop' as const, status: 'running' as const,
    priority: 0, attempt: 1, createdAt: new Date().toISOString() };
  const result = { kind: 'result' as const, runId: 'r', status: 'succeeded' as const, exitCode: 0, resultRef: 'report' };
  const check = { command: 'npm', args: ['test'], timeoutMs: 1000,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    result: 'passed' as const, exitCode: 0, logRef: 'log', terminationConfirmed: true };
  assert.equal(decideAgentEvent(task, run, result).state, 'blocked');
  assert.equal(decideAgentEvent(task, run, { ...result, resultRef: undefined }).state, 'blocked');
  assert.equal(decideAgentEvent(task, run, { ...result, development: { baseSha, commitSha: 'b'.repeat(40),
    diffRef: 'diff', postCheckVerified: true, checks: [{ ...check, result: 'failed', exitCode: 1 }] } }).state, 'blocked');
  assert.equal(decideAgentEvent(task, run, { ...result, development: { baseSha, commitSha: 'b'.repeat(40),
    diffRef: 'diff', postCheckVerified: true, checks: [check] } }).queueStage, 'verify');
  assert.equal(decideAgentEvent(task, run, { ...result, development: { baseSha, commitSha: 'b'.repeat(40),
    diffRef: 'diff', postCheckVerified: false, checks: [check] } }).state, 'blocked');
});

test('linked event wakes an idle Task once and later burst inputs share its queued Run', () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    coordinator.processPending();
    const firstId = String(store.db.prepare('SELECT id FROM run').get()?.id);
    const first = store.getRun(firstId)!;
    store.replaceRun({ ...first, status: 'succeeded' }, 'queued');
    for (const externalId of ['followup-1', 'followup-2']) {
      store.accept({ ...event, externalId, revision: externalId });
      coordinator.processPending();
    }
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE status='queued'").get()?.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='event_link'").get()?.n, 3);
  } finally { store.close(); }
});

test('followups held while a runner cannot accept input create one successor Run after result', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    coordinator.processPending();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    store.setTaskBaseRef(taskId, 'a'.repeat(40));
    const at = new Date();
    const active = store.claimRun('worker', at.toISOString(), new Date(at.getTime() + 60_000).toISOString(),
      { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 }, ['qoder'])!;
    store.setEventLinkStatus(taskId, store.getTask(taskId)!.originEventId!, 'pending', 'delivered');
    for (const externalId of ['followup-a', 'followup-b']) {
      store.accept({ ...event, externalId, revision: externalId });
      coordinator.processPending();
    }
    await coordinator.onSignal({ kind: 'agent_event', taskId,
      event: { kind: 'result', runId: active.id, status: 'succeeded', exitCode: 0, resultRef: 'report' } });
    assert.equal(store.getTask(taskId)?.state, 'investigating');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE status='queued'").get()?.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='approval_request'").get()?.n, 0);
  } finally { store.close(); }
});

test('develop waits for a low-risk policy result before workspace or CLI startup', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    coordinator.processPending();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const first = store.getRun(String(store.db.prepare('SELECT id FROM run').get()?.id))!;
    store.replaceRun({ ...first, status: 'succeeded' }, 'queued');
    store.setTaskBaseRef(taskId, 'a'.repeat(40));
    store.saveTransition(taskId, 'investigating', 'started', new Date().toISOString(), 's1', { kind: 'system', id: 'test' });
    store.saveTransition(taskId, 'waiting_human', 'scope', new Date().toISOString(), 's2', { kind: 'system', id: 'test' });
    const current = store.getTask(taskId)!;
    store.saveApprovalRequest({ kind: 'scope_change', id: 'scope', taskId, iteration: 1,
      sourceSha: 'a'.repeat(40), policyVersion: 'p1', proposedMandate: { ...current.mandate,
        allowedActions: ['investigate', 'edit'], authority: { kind: 'human_approval', approvalRef: 'scope' } } });
    await coordinator.onSignal({ kind: 'human_response', taskId, response: { kind: 'approval_decision', value: { requestId: 'scope', actor: { kind: 'human', id: 'owner' }, decision: 'approve',
      at: new Date().toISOString(), idempotencyKey: 'k' } } });
    let prepared = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { throw new Error('Must not start'); }, async resume() { return { kind: 'unsupported' }; },
        async send() { return { kind: 'unsupported' }; }, async read() { return { kind: 'unknown', runId: 'r' }; },
        async cancel() { return { kind: 'unsupported' }; } } },
      workspace: { async prepare() { prepared = true; throw new Error('Must not prepare'); } },
      skills: { async load() { throw new Error('Must not load'); } },
      boundary: { async attest() { throw new Error('Must not attest'); } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), policyVersion: 'p1',
      maxRunMs: 60_000, limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2,
        perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(prepared, false);
    assert.equal(store.getTask(taskId)?.state, 'waiting_human');
  } finally { store.close(); }
});

test('execution proof for a different workspace never starts the runner', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    coordinator.processPending();
    let started = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { started = true; return { sessionId: 's' }; }, async resume() { return { kind: 'unsupported' }; },
        async send() { return { kind: 'unsupported' }; }, async read() { return { kind: 'unknown', runId: 'r' }; },
        async cancel() { return { kind: 'unsupported' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/right', baseSha: 'a'.repeat(40) }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId,
        repoKey: value.repoKey, workspacePath: '/tmp/wrong', mode: 'read',
        adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(started, false);
    assert.equal(store.db.prepare('SELECT status FROM run').get()?.status, 'paused');
  } finally { store.close(); }
});

test('empty or missing pinned Skill fails Run and blocks Task before workspace creation', async () => {
  const store = new SqliteStore(':memory:', { [sourceId]: [] });
  try {
    store.registerSource(sourceId, 'fixture', 'fixture', true);
    store.accept(event);
    const coordinator = createKernelCoordinator(store, { [sourceId]: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    coordinator.processPending();
    let prepared = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start() { throw new Error('Must not start'); }, async resume() { return { kind: 'unsupported' }; },
        async send() { return { kind: 'unsupported' }; }, async read() { return { kind: 'unknown', runId: 'r' }; },
        async cancel() { return { kind: 'unsupported' }; } } },
      workspace: { async prepare() { prepared = true; throw new Error('Must not prepare'); } },
      skills: { async load() { throw new Error('empty Skill'); } },
      boundary: { async attest() { throw new Error('Must not attest'); } },
      skillRepoPath: 'agent-platform', skillCommitSha: 'a'.repeat(40), maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(prepared, false);
    assert.equal(store.db.prepare('SELECT status FROM run').get()?.status, 'failed');
    assert.equal(store.db.prepare('SELECT state FROM task').get()?.state, 'blocked');
  } finally { store.close(); }
});
