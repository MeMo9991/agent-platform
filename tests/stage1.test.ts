import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createEventIngress } from '../src/event/ingress.js';
import { normalizedEvent } from '../src/event/model.js';
import { mandate as mandateSchema, taskRecord, type Task } from '../src/agent/task/model.js';
import { reopenTask, transitionTask } from '../src/agent/task/transition.js';
import { agentEvent, agentInput, agentUsage, run } from '../src/agent/worker/model.js';
import { approvalDecision, approvalRequest, humanResponse, routeReviewDecision } from '../src/interaction/model.js';
import { routeDecision } from '../src/agent/router/model.js';
import { skillRef } from '../src/skills/model.js';
import { platformConfig, selectAgentRunner, selectCodeHost, selectReleasePipeline, selectSource } from '../src/bootstrap/config.js';
import { denyUnconfigured, investigationMandate } from '../src/authorization/model.js';
import { unavailableAgent, unavailableCodeHost, unavailableReleasePipeline } from '../src/bootstrap/ports.js';
import { releaseRequest, releaseSnapshot } from '../src/repository-ci/model.js';
import { kernelSignal } from '../src/agent/kernel/model.js';

const now = '2026-11-04T00:00:00.000Z';
const event = { sourceId: 'page', externalId: 'comment-1', revision: '1', kind: 'bug', title: '中文 Bug',
  body: '页面无法打开', objectKey: '42', attachments: [{ id: 'shot', kind: 'image' as const, sourceRef: 'page/shot' }], metaData: { tag: 'UI' } };
const allowedMetaDataFields = { page: ['tag'], another: ['tag'] };
const mandate = investigationMandate('event-1', 'repo-1', '调查', 'v1', 'intake-rule-1');
const task: Task = { id: 'task-1', repoKey: 'repo-1', title: '中文 Bug', scope: '调查', mandate, state: 'new',
  iteration: 1, priority: 1, createdAt: now, updatedAt: now };

test('released Task reopens into a new investigation iteration without old edit permission', () => {
  const old: Task = { ...task, state: 'released', iteration: 3, baseRef: 'a'.repeat(40),
    mandate: { ...mandate, allowedActions: ['investigate', 'edit'],
      authority: { kind: 'human_approval', approvalRef: 'old-approval' } } };
  const result = reopenTask(old, 'Confirmed recurrence', now, 'state-record', 'reopen-record',
    { kind: 'human', id: 'owner' });
  assert.equal(result.task.state, 'queued');
  assert.equal(result.task.iteration, 4);
  assert.equal(result.task.baseRef, undefined);
  assert.deepEqual(result.task.mandate.allowedActions, ['investigate']);
  assert.deepEqual(result.task.mandate.authority, { kind: 'human_approval', approvalRef: 'reopen-record' });
  assert.equal(old.state, 'released');
  assert.equal(old.baseRef, 'a'.repeat(40));
});

test('event ingress preserves facts, deduplicates by source identity and survives reopen', async () => {
  const store = new SqliteStore(':memory:', allowedMetaDataFields);
  try {
    store.registerSource('page', 'page', 'page-config', true);
    store.registerSource('another', 'page', 'another-config', true);
    const ingress = createEventIngress(store, allowedMetaDataFields);
    const first = await ingress.accept(event);
    assert.equal(first.duplicate, false);
    assert.deepEqual(await ingress.accept({ ...event, body: 'changed with same revision' }), { eventId: first.eventId, duplicate: true });
    assert.equal(store.get(first.eventId)?.body, event.body);
    assert.equal(store.get(first.eventId)?.attachments[0]?.sourceRef, 'page/shot');
    assert.equal((await ingress.accept({ ...event, sourceId: 'another' })).duplicate, false);
    assert.equal((await ingress.accept({ ...event, externalId: 'comment-2' })).duplicate, false);
    assert.equal((await ingress.accept({ ...event, revision: '2' })).duplicate, false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_event').get()?.n, 4);
  } finally { store.close(); }
});

test('invalid event identity, unsafe attachment and secret metadata are rejected', async () => {
  assert.equal(normalizedEvent.safeParse({ ...event, externalId: '' }).success, false);
  assert.equal(normalizedEvent.safeParse({ ...event, attachments: [{ id: 'x', kind: 'image', sourceRef: 'https://host/file?token=x' }] }).success, false);
  assert.equal(normalizedEvent.safeParse({ ...event, metaData: { accessToken: 'secret' } }).success, false);
  assert.equal(normalizedEvent.safeParse({ ...event, metaData: { token: 'secret' } }).success, false);
  assert.equal(normalizedEvent.safeParse({ ...event, metaData: { credential: 'plain-secret' } }).success, false);
  const store = new SqliteStore(':memory:', allowedMetaDataFields);
  try {
    store.registerSource('page', 'page', 'page-config', true);
    const ingress = createEventIngress(store, allowedMetaDataFields);
    await assert.rejects(ingress.accept({ ...event, metaData: { credential: 'plain-secret' } }));
    assert.throws(() => store.accept({ ...event, metaData: { credential: 'plain-secret' } }));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_event').get()?.n, 0);
  } finally { store.close(); }
});

test('event repository rejects unregistered and disabled sources, including duplicate writes', () => {
  const store = new SqliteStore(':memory:', allowedMetaDataFields);
  try {
    assert.throws(() => store.accept(event), /not registered or enabled/);
    store.registerSource('page', 'page', 'page-config', false);
    assert.throws(() => store.accept(event), /not registered or enabled/);
    store.registerSource('page', 'page', 'page-config', true);
    store.accept(event);
    store.registerSource('page', 'page', 'page-config', false);
    assert.throws(() => store.accept(event), /not registered or enabled/);
    assert.equal(store.listPending(10).length, 1);
  } finally { store.close(); }
});

test('migration is idempotent, future schema rejected, transactions roll back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-'));
  const path = join(directory, 'test.sqlite3');
  const store = new SqliteStore(path);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.throws(() => store.transaction(() => { store.db.exec("INSERT INTO event_source VALUES ('x','page','ref',NULL,1)"); throw new Error('fail'); }));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM event_source').get()?.n, 0);
  } finally { store.close(); }
  const reopened = new SqliteStore(path);
  reopened.db.exec('PRAGMA user_version=6');
  reopened.close();
  try { assert.throws(() => new SqliteStore(path), /future database version/); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('task transition and local record serialization reject false progress', () => {
  const store = new SqliteStore(':memory:');
  try {
    store.saveTask(task);
    assert.deepEqual(store.getTask(task.id), task);
    const actor = { kind: 'system' as const, id: 'router' };
    assert.throws(() => transitionTask(task, 'released', 'no proof', now, 'r0', actor));
    const result = store.saveTransition(task.id, 'triaged', 'accepted', now, 'r1', actor);
    assert.equal(result.task.state, 'triaged');
    const record = result.record;
    assert.equal(store.getTask(task.id)?.state, 'triaged');
    assert.deepEqual(store.getRecord(record.id), record);
    assert.throws(() => store.saveTransition(task.id, 'triaged', 'again', now, 'r2', actor), /Invalid task transition/);
    assert.throws(() => store.saveTransition(task.id, 'queued', 'ready', now, record.id, actor));
    assert.equal(store.getTask(task.id)?.state, 'triaged');
    assert.equal(taskRecord.safeParse({ ...record, reason: '' }).success, false);
    const execution = { id: 'run-1', taskId: task.id, iteration: 1, stage: 'investigate' as const,
      status: 'queued' as const, priority: 1, attempt: 0, usage: { kind: 'unknown' as const }, createdAt: now,
      skillRef: { repoRef: 'platform', path: 'skills/investigate/SKILL.md', commitSha: 'abc123', stage: 'investigate' as const } };
    store.saveRun(execution);
    assert.deepEqual(store.getRun(execution.id), execution);
    assert.equal(run.safeParse({ ...execution, skillRef: 'plain-string' }).success, false);
    assert.equal(run.safeParse({ ...execution, skillRef: { ...execution.skillRef, stage: 'review' } }).success, false);
  } finally { store.close(); }
});

test('state transitions cannot persist a caller-forged Mandate', () => {
  const store = new SqliteStore(':memory:');
  try {
    store.saveTask(task);
    const forged = transitionTask({ ...task, mandate: { ...task.mandate, allowedActions: ['release'],
      authority: { kind: 'human_approval', approvalRef: 'forged' } } }, 'triaged', 'accepted', now, 'forged-record', { kind: 'system', id: 'router' });
    assert.throws(() => store.saveTransition(forged as never, 'triaged', 'accepted', now, 'r1', { kind: 'system', id: 'router' }));
    assert.deepEqual(store.getTask(task.id)?.mandate, task.mandate);
    store.saveTransition(task.id, 'triaged', 'accepted', now, 'r1', { kind: 'system', id: 'router' });
    assert.deepEqual(store.getTask(task.id)?.mandate, task.mandate);
  } finally { store.close(); }
});

test('task and mandate cannot name different repositories', () => {
  const store = new SqliteStore(':memory:');
  try {
    assert.throws(() => store.saveTask({ ...task, repoKey: 'repo-a', mandate: { ...task.mandate, repoKey: 'repo-b' } }));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 0);
  } finally { store.close(); }
});

test('default mandate and unconfigured effects cannot grant external actions', async () => {
  const value = investigationMandate('e', 'repo-1', 'investigate', 'v1', 'rule-1');
  assert.deepEqual(value.allowedActions, ['investigate']);
  assert.equal(mandateSchema.safeParse({ ...value, allowedActions: ['release'] }).success, false);
  assert.equal(mandateSchema.safeParse({ ...value, authority: undefined, allowedActions: ['release'] }).success, false);
  const store = new SqliteStore(':memory:');
  try {
    assert.throws(() => store.saveTask({ ...task, mandate: { ...value, allowedActions: ['release'], authority: { kind: 'human_approval', approvalRef: 'unverified' } } }), /verified authorization service/);
  } finally { store.close(); }
  assert.equal((await denyUnconfigured.execute({ taskId: 't', action: 'merge', repoKey: 'r', idempotencyKey: 'k', policyVersion: 'v1' })).kind, 'denied');
  await assert.rejects(unavailableAgent.start({} as never), /unavailable/);
  await assert.rejects(unavailableCodeHost.readChecks('sha'), /unavailable/);
  await assert.rejects(unavailableReleasePipeline.start({} as never), /unavailable/);
});

test('agent and human messages remain typed and unknown usage stays unknown', () => {
  assert.equal(agentInput.safeParse({ kind: 'human_answer', questionId: 'q', content: 'yes', idempotencyKey: 'a' }).success, true);
  assert.equal(agentEvent.safeParse({ kind: 'result', runId: 'r', status: 'succeeded', exitCode: 0 }).success, true);
  assert.equal(agentEvent.safeParse({ kind: 'raw_stdout', runId: 'r', text: 'done' }).success, false);
  assert.deepEqual(agentUsage.parse({ kind: 'unknown' }), { kind: 'unknown' });
  assert.equal(humanResponse.safeParse({ kind: 'answer', value: { questionId: 'q', actor: { kind: 'human', id: 'u' }, content: 'ok', idempotencyKey: 'a' } }).success, true);
  assert.equal(routeReviewDecision.safeParse({ choice: 'existing_task', eventId: 'e', actor: { kind: 'human', id: 'u' }, at: now, idempotencyKey: 'a', reason: 'same bug' }).success, false);
  assert.equal(routeReviewDecision.safeParse({ choice: 'ignored', eventId: 'e', actor: { kind: 'agent', id: 'bot' }, at: now, idempotencyKey: 'a', reason: 'x' }).success, false);
  assert.equal(approvalDecision.safeParse({ requestId: 'a', actor: { kind: 'agent', id: 'bot' }, decision: 'approve', at: now, idempotencyKey: 'k' }).success, false);
  assert.equal(approvalRequest.safeParse({ kind: 'action', id: 'a', taskId: 't', action: 'merge', sourceSha: 'sha', policyVersion: 'v1' }).success, false);
  assert.equal(approvalRequest.safeParse({ kind: 'action', id: 'a', taskId: 't', action: 'release', sourceSha: 'sha', environment: 'prod', releaseVersion: 'v1', policyVersion: 'p1' }).success, false);
  assert.equal(approvalRequest.safeParse({ kind: 'action', id: 'a', taskId: 't', action: 'release', sourceSha: 'sha', environment: 'prod', releaseVersion: 'v1', releaseTargetDigest: 'digest', policyVersion: 'p1' }).success, true);
  assert.equal(routeDecision.safeParse({ kind: 'needs_human', candidates: [], reason: 'similar only' }).success, true);
  assert.equal(skillRef.safeParse({ repoRef: 'r', path: '../secret', commitSha: 'sha', stage: 'review' }).success, false);
});

test('repo configuration binds only the selected code host', () => {
  const config = platformConfig.parse({ repositories: [
    { repoKey: 'a', provider: 'github', hostUrl: 'https://github.com', projectRef: 'x/a', targetBranch: 'main', requiredChecks: [], credentialsRef: 'env:GH' },
    { repoKey: 'b', provider: 'github', hostUrl: 'https://github.com', projectRef: 'x/b', targetBranch: 'main', requiredChecks: [], credentialsRef: 'env:GH' },
    { repoKey: 'c', provider: 'gitlab', hostUrl: 'https://gitlab.com', projectRef: 'x/c', targetBranch: 'main', requiredChecks: [], credentialsRef: 'env:GL' },
  ], sources: [], agents: [], budget: { maxRunMs: 1000 }, policyRef: 'v1' });
  const a = { repoKey: 'a', provider: 'github' } as Parameters<typeof selectCodeHost>[2]['a'];
  const b = { repoKey: 'b', provider: 'github' } as Parameters<typeof selectCodeHost>[2]['b'];
  const c = { repoKey: 'c', provider: 'gitlab' } as Parameters<typeof selectCodeHost>[2]['c'];
  assert.equal(selectCodeHost('a', config, { a, b }), a);
  assert.equal(selectCodeHost('b', config, { a, b }), b);
  assert.equal(selectCodeHost('c', config, { c }), c);
  assert.throws(() => selectCodeHost('a', config, { a: b }));
  assert.throws(() => selectCodeHost('missing', config, { a, b }));
  assert.equal(platformConfig.safeParse({ ...config, repositories: [config.repositories[0], config.repositories[0]] }).success, false);
});

test('release contract retains deployment target and recovery identity', () => {
  const request = { operation: 'deploy', taskId: 't', repoKey: 'r', mergedSha: 'sha', environment: 'prod',
    releaseVersion: 'v1', artifactRef: 'sha256:artifact', pipelineConfigRef: 'pipeline-1', paramsDigest: 'sha256:params', requestKey: 'deploy-t-v1' };
  assert.equal(releaseRequest.safeParse(request).success, true);
  assert.equal(releaseRequest.safeParse({ ...request, paramsDigest: undefined }).success, false);
  assert.equal(releaseSnapshot.safeParse({ runRef: 'run-1', requestKey: request.requestKey, operation: 'deploy', environment: 'prod', state: 'running', observedAt: now }).success, true);
});

test('kernel signal and adapter registration stay independent of implementations', () => {
  assert.equal(kernelSignal.safeParse({ kind: 'source_event', eventId: 'e' }).success, true);
  assert.equal(kernelSignal.safeParse({ kind: 'recovery', taskId: 't', runId: 'r' }).success, true);
  assert.equal(kernelSignal.safeParse({ kind: 'agent_event', taskId: 't', event: { kind: 'progress', runId: 'r', text: 'working', at: now } }).success, true);
  const config = platformConfig.parse({ repositories: [{ repoKey: 'a', provider: 'github', hostUrl: 'https://github.com', projectRef: 'x/a', targetBranch: 'main', requiredChecks: [], credentialsRef: 'env:GH' }],
    sources: [{ id: 'page', kind: 'page', configRef: 'page-config', enabled: true }], agents: [{ kind: 'qoder', enabled: true }],
    releasePipelines: [{ repoKey: 'a', environment: 'prod', configRef: 'pipeline-config' }], budget: { maxRunMs: 1000 }, policyRef: 'v1' });
  const source = { mode: 'polling' as const, source: { read: async () => ({ events: [] }) } };
  const runner = { capabilities: () => ({ image: 'supported' as const }) } as Parameters<typeof selectAgentRunner>[2]['qoder'];
  const pipeline = { repoKey: 'a', environment: 'prod' } as Parameters<typeof selectReleasePipeline>[3]['a'] extends infer T ? NonNullable<T>['prod'] : never;
  assert.equal(selectSource('page', config, { page: source }), source);
  assert.equal(selectAgentRunner('qoder', config, { qoder: runner }, ['image']), runner);
  assert.equal(selectReleasePipeline('a', 'prod', config, { a: { prod: pipeline } }), pipeline);
  assert.throws(() => selectSource('unknown', config, { page: source }));
  assert.throws(() => selectAgentRunner('qoder', config, { qoder: runner }, ['cancel']));
  assert.throws(() => selectReleasePipeline('a', 'staging', config, { a: { prod: pipeline } }));
});
