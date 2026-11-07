import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from '../src/agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../src/agent/router/candidate-finder.js';
import { startLocalApi } from '../src/api/local.js';
import { createManualAttachmentReader } from '../src/event/sources/manual/attachment.js';
import { completeTakeover, executeTaskCommand } from '../src/api/task-command.js';
import type { AgentRunner } from '../src/agent/worker/model.js';
import { createQoderRunner, unavailableQoderLauncher } from '../src/agent/worker/agents/qoder.js';
import { createGitWorkspaceManager } from '../src/agent/worker/workspace.js';

test('stage four accepts one image task, routes it, versions commands and splits through Router', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-stage4-'));
  const images = join(directory, 'images');
  const store = new SqliteStore(':memory:', { 'manual:repo': ['contentDigest'] });
  store.registerSource('manual:repo', 'manual', 'repo', true);
  const coordinator = createKernelCoordinator(store, { 'manual:repo': 'repo' }, 'p1', 'manual',
    'qoder', ['repo'], createTaskCandidateFinder(store));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['route', 'submit', 'command'], dashboard: { actorId: 'owner',
        repoKeys: ['repo'], imageDirectory: images,
        attachmentReaders: { 'manual:repo': createManualAttachmentReader('manual:repo', images) } } });
    const token = readFileSync(join(directory, 'token'), 'utf8');
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
        method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a6p0AAAAASUVORK5CYII=';
    const input = { repoKey: 'repo', body: '修复中文截图中的问题', idempotencyKey: 'submit-1',
      images: [{ data: png, mimeType: 'image/png' }] };
    const first = await request('/api/events', input);
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const second = await request('/api/events', input);
    assert.equal(second.status, 202);
    assert.equal(second.body.eventId, first.body.eventId);
    assert.equal(second.body.duplicate, true);
    assert.equal((await request('/api/events', { ...input, body: 'different' })).status, 409);
    assert.equal((await request('/api/events', { ...input, repoKey: 'unknown' })).status, 409);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_event').get()?.n, 1);
    coordinator.processPending();
    assert.equal(store.get(String(first.body.eventId))?.status, 'needs_human');
    const route = await request(`/api/events/${first.body.eventId}/routes`, { choice: 'new_task',
      repoKey: 'repo', reason: '独立任务', idempotencyKey: 'route-1' });
    assert.equal(route.status, 200, JSON.stringify(route.body));
    const taskId = String(route.body.taskId);
    const detail = await request(`/api/tasks/${taskId}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.task.version >= 2);
    assert.equal(JSON.stringify(detail.body).includes(directory), false);
    const image = await fetch(`http://127.0.0.1:${server.port}/api/events/${first.body.eventId}/images/${detail.body.events[0].attachments[0].id}`,
      { headers: { authorization: `Bearer ${token}` } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/events/${first.body.eventId}/images/${detail.body.events[0].attachments[0].id}`)).status, 401);
    assert.equal((await request(`/api/tasks/${taskId}/commands`, { kind: 'pause', expectedVersion: 1,
      idempotencyKey: 'pause-old', reason: 'review' })).status, 409);
    const version = Number(detail.body.task.version);
    const paused = await request(`/api/tasks/${taskId}/commands`, { kind: 'pause', expectedVersion: version,
      idempotencyKey: 'pause-1', reason: 'review' });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(store.getTask(taskId)?.state, 'paused');
    assert.equal((await request(`/api/tasks/${taskId}/commands`, { kind: 'pause', expectedVersion: version,
      idempotencyKey: 'pause-1', reason: 'review' })).status, 200);
    const split = await request(`/api/tasks/${taskId}/split`, { expectedVersion: paused.body.version,
      description: '独立的新增问题，需要单独调查', idempotencyKey: 'split-1' });
    assert.equal(split.status, 202, JSON.stringify(split.body));
    coordinator.processPending();
    const child = store.db.prepare('SELECT id FROM task WHERE parent_task_id=?').get(taskId);
    assert.ok(child);
    assert.equal((await request(`/api/tasks/${taskId}/split`, { expectedVersion: 1,
      description: '独立的新增问题，需要单独调查', idempotencyKey: 'split-1' })).body.eventId, split.body.eventId);
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an answer-only credential cannot submit or command through the dashboard', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-stage4-role-'));
  const store = new SqliteStore(':memory:');
  const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['repo'], createTaskCandidateFinder(store));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['answer'], dashboard: { actorId: 'owner', repoKeys: ['repo'],
        imageDirectory: join(directory, 'images'), attachmentReaders: {} } });
    const headers = { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}`,
      'content-type': 'application/json' };
    const base = `http://127.0.0.1:${server.port}`;
    const config = await (await fetch(`${base}/api/config`, { headers })).json();
    assert.deepEqual(config.roles, ['answer']);
    assert.equal((await fetch(`${base}/api/events`, { method: 'POST', headers,
      body: JSON.stringify({ repoKey: 'repo', body: 'work', idempotencyKey: 'one' }) })).status, 409);
    assert.equal((await fetch(`${base}/api/tasks/any/commands`, { method: 'POST', headers,
      body: JSON.stringify({ kind: 'cancel', expectedVersion: 1, idempotencyKey: 'one', reason: 'test' }) })).status, 409);
    assert.equal((await fetch(`${base}/api/tasks/any/content-reviews`, { method: 'POST', headers,
      body: JSON.stringify({ expectedVersion: 1, targetKind: 'result', targetId: 'run',
        text: '未经授权的结论', idempotencyKey: 'review-one' }) })).status, 409);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM source_event').get()?.n, 0);
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('automatically routed submission exposes its Task through the event link', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-stage4-route-link-'));
  const store = new SqliteStore(':memory:', { 'manual:repo': ['contentDigest'] });
  store.registerSource('manual:repo', 'manual', 'repo', true);
  const coordinator = createKernelCoordinator(store, { 'manual:repo': 'repo' }, 'p1', 'manual',
    'qoder', ['repo'], createTaskCandidateFinder(store));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['submit'], dashboard: { actorId: 'owner', repoKeys: ['repo'],
        imageDirectory: join(directory, 'images'), attachmentReaders: {} } });
    const headers = { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}`,
      'content-type': 'application/json' };
    const base = `http://127.0.0.1:${server.port}`;
    const submission = { repoKey: 'repo', body: '调查独立的服务启动错误并给出修复建议', idempotencyKey: 'automatic-1' };
    const first = await (await fetch(`${base}/api/events`, { method: 'POST', headers,
      body: JSON.stringify(submission) })).json();
    assert.equal(first.taskId, undefined);
    coordinator.processPending();
    const event = await (await fetch(`${base}/api/events/${first.eventId}`, { headers })).json();
    assert.equal(event.status, 'done');
    assert.equal(typeof event.taskId, 'string');
    assert.equal(store.getTask(event.taskId)?.originEventId, first.eventId);
    const repeated = await (await fetch(`${base}/api/events`, { method: 'POST', headers,
      body: JSON.stringify(submission) })).json();
    assert.equal(repeated.taskId, event.taskId);
    store.handbackEvent(event.taskId, first.eventId, 'Needs another owner');
    const handedBack = await (await fetch(`${base}/api/events/${first.eventId}`, { headers })).json();
    assert.equal(handedBack.taskId, undefined);
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('human route can create a related Task from a closed candidate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-stage4-parent-'));
  const store = new SqliteStore(':memory:', { 'manual:repo': ['contentDigest'] });
  store.registerSource('manual:repo', 'manual', 'repo', true);
  const at = new Date().toISOString();
  store.saveTask({ id: 'closed-parent', repoKey: 'repo', title: '数据库启动故障调查', scope: '数据库启动故障调查',
    mandate: { sourceEventId: 'old-event', repoKey: 'repo', goal: '调查故障',
      allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'trusted_rule', ruleRef: 'test' } },
    state: 'closed', iteration: 1, priority: 0, createdAt: at, updatedAt: at });
  const coordinator = createKernelCoordinator(store, { 'manual:repo': 'repo' }, 'p1', 'manual',
    'qoder', ['repo'], createTaskCandidateFinder(store));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['submit', 'route'], dashboard: { actorId: 'owner', repoKeys: ['repo'],
        imageDirectory: join(directory, 'images'), attachmentReaders: {} } });
    const headers = { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}`,
      'content-type': 'application/json' };
    const base = `http://127.0.0.1:${server.port}`;
    const accepted = await (await fetch(`${base}/api/events`, { method: 'POST', headers,
      body: JSON.stringify({ repoKey: 'repo', body: '数据库启动故障调查，发现新的相关症状', idempotencyKey: 'related' }) })).json();
    coordinator.processPending();
    const event = await (await fetch(`${base}/api/events/${accepted.eventId}`, { headers })).json();
    assert.equal(event.status, 'needs_human');
    assert.ok(event.routing.candidates.some((candidate: { taskId: string }) => candidate.taskId === 'closed-parent'));
    const routed = await (await fetch(`${base}/api/events/${accepted.eventId}/routes`, { method: 'POST', headers,
      body: JSON.stringify({ choice: 'new_task', repoKey: 'repo', parentTaskId: 'closed-parent',
        reason: '旧故障的新症状', idempotencyKey: 'parent-route' }) })).json();
    assert.equal(store.getTask(routed.taskId)?.parentTaskId, 'closed-parent');
    assert.notDeepEqual(store.getTask(routed.taskId)?.mandate, store.getTask('closed-parent')?.mandate);
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('task detail withholds unreviewed Agent text and returns path-free development evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-stage4-evidence-'));
  const store = new SqliteStore(':memory:');
  const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['repo'], createTaskCandidateFinder(store));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    const at = new Date().toISOString();
    const log = join(directory, `run-${createHash('sha256').update('session').digest('hex')}.json`);
    const conclusion = '调查完成，文件 /Users/test/private.js 已核查；token: Bearer demo-secret\nAuthorization: Bearer super-secret';
    const stdout = JSON.stringify({ type: 'result', session_id: 'session', subtype: 'success',
      is_error: false, result: conclusion });
    writeFileSync(log, JSON.stringify({ runId: 'run', nativeSessionId: 'session', exitCode: 0,
      closedAt: at, terminationConfirmed: true, stdout }), { mode: 0o600 });
    mkdirSync(join(directory, 'evidence'));
    mkdirSync(join(directory, 'check-logs'));
    const diff = join(directory, 'evidence', 'change.patch');
    const checkLog = join(directory, 'check-logs', 'check.log');
    writeFileSync(diff, 'diff --git a/a.ts b/a.ts\n+safe change\n', { mode: 0o600 });
    writeFileSync(checkLog, 'passed', { mode: 0o600 });
    store.saveTask({ id: 'task', repoKey: 'repo', title: 'Work', scope: 'Investigate',
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Investigate', allowedActions: ['investigate'],
        maxAutoRisk: 'low', policyVersion: 'p1', authority: { kind: 'trusted_rule', ruleRef: 'test' } },
      state: 'queued', iteration: 1, priority: 0, createdAt: at, updatedAt: at });
    store.saveRun({ id: 'run', taskId: 'task', iteration: 1, stage: 'develop', status: 'failed',
      priority: 0, attempt: 1, agentKind: 'qoder', sessionId: 'session', resultRef: log, createdAt: at });
    store.saveRecord({ id: 'report', taskId: 'task', runId: 'run', kind: 'agent_report',
      status: 'succeeded', summary: log, at });
    store.saveRecord({ id: 'secret-progress', taskId: 'task', runId: 'run', kind: 'agent_report',
      status: 'progress', summary: 'Authorization: Bearer progress-secret', at });
    store.saveRecord({ id: 'secret-question', taskId: 'task', runId: 'run', kind: 'question',
      status: 'open', prompt: 'Can you check token: Bearer question-secret?', at });
    store.saveRecord({ id: 'development', taskId: 'task', runId: 'run', kind: 'development',
      baseSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), diffRef: diff, postCheckVerified: true,
      postCheckError: 'token: Bearer error-secret', at });
    const unrelated = join(directory, 'unrelated.txt');
    writeFileSync(unrelated, 'private', { mode: 0o600 });
    store.saveRecord({ id: 'unrelated', taskId: 'task', runId: 'run', kind: 'development',
      baseSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), diffRef: unrelated, postCheckVerified: false, at });
    store.saveRecord({ id: 'check', taskId: 'task', kind: 'check', subjectSha: 'b'.repeat(40),
      command: 'npm', args: ['--config=/Users/test/config', 'token: Bearer check-secret'], timeoutMs: 1000, startedAt: at, endedAt: at,
      result: 'passed', exitCode: 0, logRef: checkLog, terminationConfirmed: true, at });
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['answer', 'command'], dashboard: { actorId: 'owner', repoKeys: ['repo'],
        imageDirectory: join(directory, 'images'), attachmentReaders: {}, evidenceRoot: directory,
        runners: { qoder: createQoderRunner(unavailableQoderLauncher, directory) } } });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/tasks/task`,
      { headers: { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}` } });
    assert.equal(response.status, 200);
    const detail = await response.json() as Record<string, any>;
    assert.equal(detail.runs[0].conclusion, undefined);
    assert.equal(detail.runs[0].hasResult, true);
    assert.equal(detail.records.find((item: any) => item.id === 'secret-progress').summary, 'Agent 记录待审查');
    assert.equal(detail.records.find((item: any) => item.id === 'secret-question').prompt, undefined);
    assert.doesNotMatch(JSON.stringify(detail), /\/Users\/test|demo-secret|super-secret|progress-secret|question-secret|error-secret|check-secret/);
    assert.equal(JSON.stringify(detail).includes(directory), false);
    assert.equal(detail.records.find((item: any) => item.id === 'development').commitSha, 'b'.repeat(40));
    assert.equal(detail.records.find((item: any) => item.id === 'development').diff.sha256,
      createHash('sha256').update(readFileSync(diff)).digest('hex'));
    assert.equal(detail.records.find((item: any) => item.id === 'unrelated').diff.available, false);
    assert.equal(detail.records.find((item: any) => item.id === 'check').result, 'passed');
    assert.equal(detail.records.find((item: any) => item.id === 'check').log.recordId, 'check');
    const inbox = await fetch(`http://127.0.0.1:${server.port}/api/inbox`,
      { headers: { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}` } });
    assert.equal(inbox.status, 200);
    assert.doesNotMatch(JSON.stringify(await inbox.json()), /question-secret/);
    for (const path of ['/inbox', '/tasks/task', '/events/event']) {
      const legacy = await fetch(`http://127.0.0.1:${server.port}${path}`,
        { headers: { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}` } });
      assert.doesNotMatch(await legacy.text(), /\/Users\/test|demo-secret|super-secret|progress-secret|question-secret|error-secret|check-secret|"resultRef"|"workspaceRef"/);
    }
    const headers = { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}`,
      'content-type': 'application/json' };
    const review = async (targetKind: 'question' | 'result', targetId: string, text: string) => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/tasks/task/content-reviews`,
        { method: 'POST', headers, body: JSON.stringify({ expectedVersion: detail.task.version,
          targetKind, targetId, text, idempotencyKey: `review-${targetId}` }) });
      assert.equal(response.status, 200, await response.text());
    };
    await review('question', 'secret-question', '请确认复现步骤与预期行为');
    await review('result', 'run', '调查完成，已核对代码证据');
    const duplicate = await fetch(`http://127.0.0.1:${server.port}/api/tasks/task/content-reviews`,
      { method: 'POST', headers, body: JSON.stringify({ expectedVersion: detail.task.version,
        targetKind: 'result', targetId: 'run', text: '调查完成，已核对代码证据', idempotencyKey: 'review-run' }) });
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
    const published = await (await fetch(`http://127.0.0.1:${server.port}/api/tasks/task`, { headers })).json() as Record<string, any>;
    assert.equal(published.records.find((item: any) => item.id === 'secret-question').prompt, '请确认复现步骤与预期行为');
    assert.equal(published.runs[0].conclusion, '调查完成，已核对代码证据');
    assert.doesNotMatch(JSON.stringify(published), /demo-secret|super-secret|question-secret|"resultRef"/);
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cancelling a human-waiting Task closes the request and Run', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const at = new Date().toISOString();
    store.saveTask({ id: 'waiting', repoKey: 'repo', title: 'Question', scope: 'Investigate',
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Investigate',
        allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
        authority: { kind: 'trusted_rule', ruleRef: 'test' } },
      state: 'waiting_human', iteration: 1, priority: 0, createdAt: at, updatedAt: at });
    store.saveRun({ id: 'run', taskId: 'waiting', iteration: 1, stage: 'investigate',
      status: 'waiting_human', priority: 0, attempt: 1, agentKind: 'qoder', createdAt: at });
    store.saveRecord({ id: 'question', taskId: 'waiting', runId: 'run', kind: 'question',
      prompt: 'Need details?', status: 'open', at });
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('waiting')?.version);
    await executeTaskCommand(store, {}, 'owner', { kind: 'cancel', taskId: 'waiting', expectedVersion: version,
      idempotencyKey: 'cancel-waiting', reason: 'No longer needed' });
    assert.equal(store.getTask('waiting')?.state, 'cancelled');
    assert.equal(store.getRun('run')?.status, 'cancelled');
    assert.equal(store.getRecord('question')?.kind === 'question' && store.getRecord('question')?.status, 'dismissed');
  } finally { store.close(); }
});

test('running Task takeover waits for confirmed termination and records human result before resume', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const at = new Date().toISOString();
    store.saveTask({ id: 'task-1', repoKey: 'repo', title: 'Investigate', scope: 'Investigate',
      mandate: { sourceEventId: 'event-1', repoKey: 'repo', goal: 'Investigate',
        allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
        authority: { kind: 'trusted_rule', ruleRef: 'test' } },
      state: 'new', iteration: 1, priority: 0, baseRef: 'a'.repeat(40), createdAt: at, updatedAt: at });
    for (const state of ['triaged', 'queued', 'investigating'] as const)
      store.saveTransition('task-1', state, 'test', at, crypto.randomUUID(), { kind: 'system', id: 'test' });
    store.saveRun({ id: 'run-1', taskId: 'task-1', iteration: 1, stage: 'investigate',
      status: 'running', priority: 0, attempt: 1, agentKind: 'qoder', sessionId: 'session-1',
      workspaceRef: '/tmp/takeover-run', commitSha: 'a'.repeat(40), createdAt: at });
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task-1')?.version);
    const runner = (accepted: boolean) => ({ async cancel() { return { kind: accepted ? 'accepted' : 'unsupported' }; } }) as AgentRunner;
    const input = { kind: 'takeover' as const, taskId: 'task-1', expectedVersion: version,
      idempotencyKey: 'takeover-1', reason: 'Human review' };
    await assert.rejects(executeTaskCommand(store, { qoder: runner(false) }, 'owner', input), /unconfirmed/);
    assert.equal(store.getRun('run-1')?.status, 'running');
    assert.equal(store.getTask('task-1')?.state, 'investigating');
    await executeTaskCommand(store, { qoder: runner(true) }, 'owner', input);
    assert.equal(store.getRun('run-1')?.status, 'cancelled');
    assert.equal(store.getTask('task-1')?.state, 'paused');
    assert.equal(store.getTask('task-1')?.owner, 'owner');
    const pausedVersion = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task-1')?.version);
    await assert.rejects(executeTaskCommand(store, { qoder: runner(true) }, 'owner', {
      kind: 'resume', taskId: 'task-1', expectedVersion: pausedVersion,
      idempotencyKey: 'skip-result', reason: 'resume' }), /result is required/);
    const noChanges = { workspace: { async prepare() { return { repoKey: 'repo', path: '/tmp/takeover-run',
      baseSha: 'a'.repeat(40) }; } }, boundary: { async attest() { return undefined; } },
      localChecks: {}, policyVersion: 'p1' };
    const result = await completeTakeover(store, 'owner', { kind: 'takeover_result', taskId: 'task-1', expectedVersion: pausedVersion,
      idempotencyKey: 'result-1', summary: 'Checked the repository; investigation can continue',
      disposition: 'resume', codeChange: 'none' }, noChanges);
    assert.equal(store.getTask('task-1')?.state, 'queued');
    assert.equal(store.getTask('task-1')?.owner, undefined);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='human_result'").get()?.n, 1);
    assert.equal((await completeTakeover(store, 'owner', { kind: 'takeover_result', taskId: 'task-1', expectedVersion: pausedVersion,
      idempotencyKey: 'result-1', summary: 'Checked the repository; investigation can continue',
      disposition: 'resume', codeChange: 'none' }, noChanges)).version, result.version);
  } finally { store.close(); }
});

test('human committed code needs verified diff and isolated passing checks before handoff', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-takeover-code-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const store = new SqliteStore(':memory:');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
    writeFileSync(join(repo, 'file.txt'), 'before\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const at = new Date().toISOString();
    const prior = { id: 'human-run', taskId: 'human-task', iteration: 1, stage: 'develop' as const,
      status: 'cancelled' as const, priority: 0, attempt: 1, agentKind: 'qoder', createdAt: at };
    const workspace = createGitWorkspaceManager({ repo: { path: repo,
      remote: 'https://github.com/example/repo.git' } }, join(directory, 'runtime'), () => 'repo');
    const clone = await workspace.prepare(prior);
    git(clone.path, 'config', 'user.email', 'test@example.test');
    git(clone.path, 'config', 'user.name', 'Test');
    writeFileSync(join(clone.path, 'file.txt'), 'after\n');
    git(clone.path, 'add', '.'); git(clone.path, 'commit', '-qm', 'human fix');
    const commitSha = git(clone.path, 'rev-parse', 'HEAD');
    store.saveTask({ id: prior.taskId, repoKey: 'repo', title: 'Human fix', scope: 'Fix',
      mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Fix',
        allowedActions: ['investigate'], maxAutoRisk: 'low', policyVersion: 'p1',
        authority: { kind: 'trusted_rule', ruleRef: 'test' } },
      state: 'paused', owner: 'owner', iteration: 1, priority: 0, baseRef: clone.baseSha,
      createdAt: at, updatedAt: at });
    // The approval path has its own tests; this fixture starts after that approval was recorded.
    const approved = { ...store.getTask(prior.taskId)!, mandate: { sourceEventId: 'event', repoKey: 'repo', goal: 'Fix',
      allowedActions: ['investigate', 'edit'], maxAutoRisk: 'low', policyVersion: 'p1',
      authority: { kind: 'human_approval', approvalRef: 'approval' } } };
    store.db.prepare('UPDATE task SET mandate=?,payload_json=? WHERE id=?')
      .run(JSON.stringify(approved.mandate), JSON.stringify(approved), prior.taskId);
    const proof = { verified: true as const, runId: prior.id, repoKey: 'repo', workspacePath: clone.path,
      mode: 'write' as const, adapterVersion: 'test', configDigest: 'test' };
    store.saveRun({ ...prior, workspaceRef: clone.path, commitSha: clone.baseSha, execution: proof });
    const log = join(directory, 'check.log');
    writeFileSync(log, 'check output', { mode: 0o600 });
    let passed = false;
    let mutate = false;
    const ports = { workspace, policyVersion: 'p1', localChecks: { repo: [{ command: 'npm', args: ['test'], timeoutMs: 1000 }] },
      boundary: { async attest() { return undefined; }, runCheck(input: { proof: typeof proof; command: string;
        args: readonly string[]; cwd: string }) {
        assert.equal(input.proof.runId, prior.id);
        assert.equal(input.command, 'npm');
        assert.deepEqual(input.args, ['test']);
        assert.equal(input.cwd, clone.path);
        if (mutate) writeFileSync(join(clone.path, 'file.txt'), 'changed by check\n');
        return { completion: Promise.resolve({ result: passed ? 'passed' as const : 'failed' as const,
          exitCode: passed ? 0 : 1, logRef: log, terminationConfirmed: true }),
          async terminate() { return { terminated: true, logRef: log }; } };
      } } };
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(prior.taskId)?.version);
    const input = { kind: 'takeover_result' as const, taskId: prior.taskId, expectedVersion: version,
      idempotencyKey: 'human-code', summary: 'Fixed the issue', disposition: 'resume' as const,
      codeChange: 'committed' as const, commitSha };
    await assert.rejects(completeTakeover(store, 'owner', { ...input, codeChange: 'none', commitSha: undefined }, ports),
      /HEAD changed before reuse/);
    await assert.rejects(completeTakeover(store, 'owner', { ...input, commitSha: '0'.repeat(40) }, ports),
      /Submitted commit SHA/);
    await assert.rejects(completeTakeover(store, 'owner', input, ports), /passing, terminated evidence/);
    assert.equal(store.getTask(prior.taskId)?.state, 'paused');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='development'").get()?.n, 0);
    passed = true;
    mutate = true;
    await assert.rejects(completeTakeover(store, 'owner', input, ports), /changed during local checks/);
    assert.equal(store.getTask(prior.taskId)?.state, 'paused');
    git(clone.path, 'checkout', '--', 'file.txt');
    mutate = false;
    const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['repo'], createTaskCandidateFinder(store));
    const api = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['command'], dashboard: { actorId: 'owner', repoKeys: ['repo'],
        imageDirectory: join(directory, 'images'), attachmentReaders: {}, takeoverEvidence: ports } });
    let result: { version: number };
    try {
      const response = await fetch(`http://127.0.0.1:${api.port}/api/tasks/${prior.taskId}/takeover-result`, {
        method: 'POST', headers: { authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}`,
          'content-type': 'application/json' }, body: JSON.stringify(input) });
      result = await response.json() as { version: number };
      assert.equal(response.status, 200, JSON.stringify(result));
    } finally { await api.stop(); }
    assert.ok(result.version > version);
    assert.equal(store.getTask(prior.taskId)?.state, 'verifying');
    assert.equal(store.getTask(prior.taskId)?.owner, undefined);
    const next = store.getRun(String(store.db.prepare("SELECT id FROM run WHERE stage='verify'").get()?.id));
    assert.equal(next?.commitSha, commitSha);
    assert.equal(next?.status, 'queued');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='development'").get()?.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='check'").get()?.n, 1);
    await assert.rejects(completeTakeover(store, 'owner', { ...input, commitSha: '0'.repeat(40) }, ports),
      /Idempotency key belongs/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
