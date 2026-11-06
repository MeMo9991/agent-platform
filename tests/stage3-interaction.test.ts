import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createEventLoop, createKernelCoordinator } from './kernel-fixture.js';
import { startLocalApi } from '../src/api/local.js';
import { createWorkerManager } from '../src/agent/worker/manager.js';
import { investigationMandate } from '../src/authorization/model.js';

test('local API binds human identity and validates current approval and answer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-api-'));
  const store = new SqliteStore(':memory:', { sample: [] });
  let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    store.registerSource('sample', 'fixture', 'fixture', true);
    const event = store.accept({ sourceId: 'sample', externalId: 'e1', revision: '1', kind: 'bug', title: 'Bug', body: 'Body',
      repoKey: 'agent-platform', attachments: [], metaData: {} });
    createEventLoop(store, { sample: 'agent-platform' }, 'p1', 'fixture', 'qoder').processOne();
    const taskId = String(store.db.prepare('SELECT id FROM task').get()?.id);
    const sha = 'a'.repeat(40);
    store.setTaskBaseRef(taskId, sha);
    store.saveTransition(taskId, 'investigating', 'started', new Date().toISOString(), 'start-record', { kind: 'system', id: 'test' });
    store.saveTransition(taskId, 'waiting_human', 'scope requested', new Date().toISOString(), 'wait-record', { kind: 'system', id: 'test' });
    const current = store.getTask(taskId)!;
    store.saveApprovalRequest({ kind: 'scope_change', id: 'approval-1', taskId, iteration: 1,
      sourceSha: sha, policyVersion: 'p1', proposedMandate: { ...current.mandate, allowedActions: ['investigate', 'edit'],
        authority: { kind: 'human_approval', approvalRef: 'approval-1' } } });
    const coordinator = createKernelCoordinator(store, { sample: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    api = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'credential'), actorId: 'local-owner',
      roles: ['approve', 'answer', 'route'] });
    const url = `http://127.0.0.1:${api.port}/approvals`;
    const credential = readFileSync(join(directory, 'credential'), 'utf8');
    assert.equal(statSync(join(directory, 'credential')).mode & 0o077, 0);
    const reviewEvent = store.accept({ sourceId: 'sample', externalId: 'review', revision: '1', kind: 'bug',
      title: 'Other repository', body: 'Unknown', repoKey: 'other-repo', attachments: [], metaData: {} });
    coordinator.processPending();
    const routeResponse = await fetch(`http://127.0.0.1:${api.port}/routes`, { method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'ignored', eventId: reviewEvent.eventId,
        idempotencyKey: 'route-review-1', reason: 'Out of scope' }) });
    assert.equal(routeResponse.status, 200);
    assert.equal(store.get(reviewEvent.eventId)?.status, 'done');
    assert.equal((store.get(reviewEvent.eventId)?.routingData as { humanDecision: { actor: { id: string } } })
      .humanDecision.actor.id, 'local-owner');
    const relatedEvent = store.accept({ sourceId: 'sample', externalId: 'related', revision: '1', kind: 'bug',
      title: 'Another issue', body: 'Needs separate investigation', repoKey: 'agent-platform',
      attachments: [{ id: 'image-1', kind: 'image', sourceRef: 'fixture-image' }], metaData: {} });
    coordinator.processPending();
    assert.equal(store.get(relatedEvent.eventId)?.status, 'needs_human');
    const relatedResponse = await fetch(`http://127.0.0.1:${api.port}/routes`, { method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'new_task', eventId: relatedEvent.eventId, repoKey: 'agent-platform',
        parentTaskId: taskId, idempotencyKey: 'route-related-1', reason: 'Investigate separately' }) });
    assert.equal(relatedResponse.status, 200);
    const relatedTaskId = (await relatedResponse.json() as { taskId: string }).taskId;
    assert.equal(store.getTask(relatedTaskId)?.parentTaskId, taskId);
    const send = (body: unknown, token = credential) => fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ requestId: 'approval-1', decision: 'approve', idempotencyKey: 'k1' }, 'wrong')).status, 401);
    assert.equal((await send({ requestId: 'approval-1', decision: 'approve', idempotencyKey: 'k1',
      actor: { kind: 'human', id: 'attacker' } })).status, 409);
    assert.equal((await send({ requestId: 'approval-1', decision: 'approve', idempotencyKey: 'k1' })).status, 200);
    assert.equal((await send({ requestId: 'approval-1', decision: 'approve', idempotencyKey: 'k1' })).status, 200);
    assert.equal(store.getTask(taskId)?.mandate.authority.kind, 'human_approval');
    assert.equal(store.getTask(taskId)?.state, 'developing');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE stage='develop'").get()?.n, 1);
    assert.equal((await send({ requestId: 'approval-1', decision: 'approve', idempotencyKey: 'k2' })).status, 409);
    const developId = String(store.db.prepare("SELECT id FROM run WHERE stage='develop'").get()?.id);
    const develop = store.getRun(developId)!;
    store.replaceRun({ ...develop, status: 'waiting_human', sessionId: 'old-session',
      workspaceRef: '/tmp/test-workspace', commitSha: sha }, 'queued');
    store.saveTransition(taskId, 'waiting_human', 'question', new Date().toISOString(), 'question-state',
      { kind: 'system', id: 'test' });
    store.saveRecord({ id: 'q1', taskId, runId: developId, kind: 'question', prompt: 'Clarify?',
      status: 'open', at: new Date().toISOString() });
    const answerUrl = `http://127.0.0.1:${api.port}/answers`;
    const answerBody = { questionId: 'q1', content: 'Yes', idempotencyKey: 'answer-1' };
    const postAnswer = (value: unknown) => fetch(answerUrl, { method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await postAnswer(answerBody)).status, 409);
    store.replaceRun({ ...store.getRun(developId)!, questionTerminationVerified: true }, 'waiting_human');
    assert.equal((await postAnswer(answerBody)).status, 200);
    assert.equal((await postAnswer(answerBody)).status, 200);
    assert.equal(store.getRun(developId)?.queueClass, 'human_resume');
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE kind='answer'").get()?.status, 'pending');
    assert.equal(store.getTask(taskId)?.state, 'developing');
    assert.equal((await postAnswer({ ...answerBody, idempotencyKey: 'answer-2' })).status, 409);
    const delivered: string[] = [];
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported', resume: 'unsupported', send: 'unsupported' }),
        async start(request) { if (request.input.kind === 'task')
          delivered.push(JSON.parse(request.input.prompt).answers[0].content);
          return { sessionId: 'new-session' }; }, async resume() { return { kind: 'unsupported' }; },
        async send(_session, input) { if (input.kind === 'human_answer') delivered.push(input.content);
          return { kind: 'accepted' }; },
        async read(session) { return session === 'old-session'
          ? { kind: 'finished', runId: developId, exitCode: 0 } : { kind: 'running', runId: developId }; },
        async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/test-workspace', baseSha: sha }; } },
      skills: { async load(ref) { return { ref, content: 'Develop safely' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId,
        repoKey: value.repoKey, workspacePath: value.workspacePath,
        mode: 'write', adapterVersion: 'test', configDigest: 'test' }; } },
      riskPolicy: { assess() { return 'low'; } }, policyVersion: 'p1',
      skillRepoPath: 'agent-platform', skillCommitSha: sha, maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.deepEqual(delivered, ['Yes']);
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE kind='answer'").get()?.status, 'delivered');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE kind='session_handoff'").get()?.n, 1);
    assert.equal(store.getRun(developId)?.sessionId, 'new-session');
    assert.equal(store.get(event.eventId)?.status, 'done');
  } finally { if (api) await api.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const conclusionFails of [false, true]) test(`local API reopens a closed Task and ${conclusionFails ? 'holds an unverifiable handoff' : 'hands off reviewed evidence without reusing approval'}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-reopen-'));
  const store = new SqliteStore(':memory:', { sample: [] });
  let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    store.registerSource('sample', 'fixture', 'fixture', true);
    const at = new Date().toISOString();
    const oldSha = 'a'.repeat(40);
    const reviewedSha = 'b'.repeat(40);
    const linked = store.accept({ sourceId: 'sample', externalId: 'new-defect', revision: '1', kind: 'bug',
      title: 'Old defect recurs', body: 'Reproduction evidence', repoKey: 'agent-platform',
      objectKey: 'related-issue', attachments: [], metaData: {} });
    store.saveTask({ id: 'old-task', repoKey: 'agent-platform', title: 'Original defect', scope: 'Original scope',
      mandate: investigationMandate('original-event', 'agent-platform', 'Original goal', 'p1', 'fixture'),
      state: 'waiting_human', iteration: 1, priority: 0, baseRef: oldSha, createdAt: at, updatedAt: at });
    store.saveApprovalRequest({ kind: 'scope_change', id: 'old-approval-request', taskId: 'old-task',
      iteration: 1, sourceSha: oldSha, policyVersion: 'p1', proposedMandate: {
        ...store.getTask('old-task')!.mandate, allowedActions: ['investigate', 'edit'],
        authority: { kind: 'human_approval', approvalRef: 'old-approval-request' } } });
    store.recordApproval({ requestId: 'old-approval-request', actor: { kind: 'human', id: 'local-owner' },
      decision: 'approve', at, idempotencyKey: 'old-approval' });
    for (const [state, recordId] of [['release_pending', 'old-pending'], ['releasing', 'old-releasing'],
      ['released', 'old-released'], ['closed', 'old-closed']] as const)
      store.saveTransition('old-task', state, 'Prior release completed', at, recordId,
        { kind: 'system', id: 'fixture' });
    assert.deepEqual(store.getTask('old-task')?.mandate.allowedActions, ['investigate', 'edit']);
    store.saveRecord({ id: 'old-release', taskId: 'old-task', kind: 'release', environment: 'prod',
      version: 'v1', status: 'succeeded', at });
    store.saveTask({ id: 'related-task', originEventId: linked.eventId, repoKey: 'agent-platform',
      title: 'Related defect', scope: 'Related scope', parentTaskId: 'old-task',
      mandate: investigationMandate(linked.eventId, 'agent-platform', 'Check recurrence', 'p1', 'fixture'),
      state: 'waiting_human', iteration: 1, priority: 0, baseRef: reviewedSha, createdAt: at, updatedAt: at });
    store.saveApprovalRequest({ kind: 'scope_change', id: 'related-scope-request', taskId: 'related-task',
      iteration: 1, sourceSha: reviewedSha, policyVersion: 'p1', proposedMandate: {
        ...store.getTask('related-task')!.mandate, allowedActions: ['investigate', 'edit'],
        authority: { kind: 'human_approval', approvalRef: 'related-scope-request' } } });
    store.saveRun({ id: 'evidence-run', taskId: 'related-task', iteration: 1, stage: 'investigate',
      status: 'succeeded', priority: 0, attempt: 1, agentKind: 'qoder', sessionId: 'evidence-session',
      commitSha: reviewedSha, resultRef: '/trusted/evidence.json', createdAt: at, endedAt: at });
    store.saveRecord({ id: 'evidence-report', taskId: 'related-task', runId: 'evidence-run',
      kind: 'agent_report', status: 'succeeded', summary: '/trusted/evidence.json', at });
    store.saveRecord({ id: 'related-link', taskId: 'related-task', eventId: linked.eventId,
      kind: 'event_link', mode: 'handle', status: 'handled', at });
    store.saveSubscription({ taskId: 'related-task', sourceId: 'sample', targetKind: 'object',
      targetKey: 'related-issue', mode: 'handle' });
    const coordinator = createKernelCoordinator(store, { sample: 'agent-platform' }, 'p1', 'fixture',
      'qoder', ['agent-platform']);
    api = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'credential'),
      actorId: 'local-owner', roles: ['reopen', 'approve'] });
    const credential = readFileSync(join(directory, 'credential'), 'utf8');
    const inbox = async () => (await (await fetch(`http://127.0.0.1:${api!.port}/inbox`, {
      headers: { authorization: `Bearer ${credential}` } })).json() as { requests: Array<{ id: string }> }).requests;
    assert.deepEqual((await inbox()).map(item => item.id), ['related-scope-request']);
    const post = (body: unknown, token = credential) => fetch(`http://127.0.0.1:${api!.port}/tasks/reopen`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    const decision = { taskId: 'old-task', relatedTaskId: 'related-task', evidenceRunId: 'evidence-run',
      evidenceRecordId: 'evidence-report', finding: 'original_defect_reproduced', reviewedSha,
      expectedIteration: 1, expectedUpdatedAt: at, idempotencyKey: 'reopen-1', reason: 'Reviewed reproduction' };
    assert.equal((await post(decision, 'wrong')).status, 401);
    assert.equal((await post({ ...decision, actor: { kind: 'human', id: 'attacker' } })).status, 409);
    assert.equal((await post({ ...decision, evidenceRecordId: 'old-release' })).status, 409);
    assert.equal((await post({ ...decision, reviewedSha: 'c'.repeat(40) })).status, 409);
    store.saveRun({ id: 'busy-related-run', taskId: 'related-task', iteration: 1, stage: 'investigate',
      status: 'queued', priority: 0, attempt: 0, agentKind: 'qoder', createdAt: at });
    assert.equal((await post(decision)).status, 409);
    store.replaceRun({ ...store.getRun('busy-related-run')!, status: 'cancelled' }, 'queued');
    const uncertain = store.accept({ sourceId: 'sample', externalId: 'uncertain', revision: '1',
      kind: 'bug', title: 'Uncertain followup', body: 'Unconfirmed delivery', repoKey: 'agent-platform',
      attachments: [], metaData: {} });
    store.saveRecord({ id: 'uncertain-link', taskId: 'related-task', eventId: uncertain.eventId,
      kind: 'event_link', mode: 'handle', status: 'uncertain', at });
    assert.equal((await post(decision)).status, 409);
    store.setEventLinkStatus('related-task', uncertain.eventId, 'uncertain', 'handback');
    assert.equal(store.getRecord('related-scope-request')?.kind, 'approval_request');
    assert.equal((store.getRecord('related-scope-request') as { status: string }).status, 'open');
    assert.equal(store.getTask('old-task')?.state, 'closed');
    const response = await post(decision);
    const responseBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(responseBody));
    assert.deepEqual(responseBody, { ok: true, taskId: 'old-task', iteration: 2 });
    assert.equal(store.getTask('old-task')?.state, 'queued');
    assert.equal(store.getTask('old-task')?.iteration, 2);
    assert.equal(store.getTask('old-task')?.baseRef, undefined);
    assert.deepEqual(store.getTask('old-task')?.mandate.allowedActions, ['investigate']);
    assert.equal(store.getTask('old-task')?.mandate.authority.kind, 'human_approval');
    assert.notEqual((store.getTask('old-task')?.mandate.authority as { approvalRef: string }).approvalRef,
      'old-approval-request');
    assert.equal(store.getRecord('old-approval-request')?.kind, 'approval_request');
    assert.equal(store.getRecord('old-release')?.kind, 'release');
    assert.equal(store.getTask('related-task')?.state, 'cancelled');
    const invalidated = store.getRecord('related-scope-request');
    assert.equal(invalidated?.kind, 'approval_request');
    if (invalidated?.kind === 'approval_request') {
      assert.equal(invalidated.status, 'invalidated');
      assert.equal(invalidated.invalidatedByReopenId, store.getReopenByKey('reopen-1')?.id);
    }
    assert.deepEqual(await inbox(), []);
    const staleApproval = await fetch(`http://127.0.0.1:${api.port}/approvals`, { method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'related-scope-request', decision: 'approve',
        idempotencyKey: 'late-approval' }) });
    assert.equal(staleApproval.status, 409);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_record WHERE task_id='related-task' AND kind='reopen_transfer'").get()?.n, 1);
    assert.equal(store.db.prepare("SELECT status FROM task_record WHERE task_id='old-task' AND event_id=? AND kind='event_link'").get(linked.eventId)?.status, 'pending');
    assert.equal(store.db.prepare("SELECT mode FROM subscription WHERE task_id='related-task'").get()?.mode, 'context');
    assert.equal(store.db.prepare("SELECT mode FROM subscription WHERE task_id='old-task'").get()?.mode, 'handle');
    assert.equal(store.db.prepare("SELECT iteration FROM run WHERE task_id='old-task' AND stage='investigate'").get()?.iteration, 2);
    assert.equal((await post(decision)).status, 200);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM run WHERE task_id='old-task'").get()?.n, 1);
    assert.equal((await post({ ...decision, finding: 'prior_fix_caused_defect' })).status, 409);
    assert.equal((await post({ ...decision, idempotencyKey: 'reopen-2' })).status, 409);
    let started = false;
    const manager = createWorkerManager({ store, coordinator, enabledAgents: ['qoder'],
      runners: { qoder: { capabilities: () => ({ start: 'supported' }),
        async start(request) {
          started = true;
          const facts = JSON.parse(request.input.kind === 'task' ? request.input.prompt : '{}');
          assert.deepEqual(facts.reopenEvidence, { relatedTaskId: 'related-task', evidenceRunId: 'evidence-run',
            finding: 'original_defect_reproduced', reviewedSha, resultRef: '/trusted/evidence.json',
            conclusion: { kind: 'unverified_agent_conclusion', text: 'Confirmed the original defect recurs.' } });
          assert.equal(facts.events[0].eventId, linked.eventId);
          assert.deepEqual(request.mandate.allowedActions, ['investigate']);
          return { sessionId: 'reopened-session' };
        }, async resume() { return { kind: 'unsupported' }; }, async send() { return { kind: 'unsupported' }; },
        async read() { return { kind: 'running', runId: 'unused' }; },
        async resultSummary(runId, sessionId, resultRef) {
          assert.deepEqual([runId, sessionId, resultRef],
            ['evidence-run', 'evidence-session', '/trusted/evidence.json']);
          if (conclusionFails) throw new Error('Related investigation log is unavailable');
          return 'Confirmed the original defect recurs.';
        }, async cancel() { return { kind: 'accepted' }; } } },
      workspace: { async prepare() { return { repoKey: 'agent-platform', path: '/tmp/reopened-clone',
        baseSha: reviewedSha }; } },
      skills: { async load(ref) { return { ref, content: 'Investigate the recurrence' }; } },
      boundary: { async attest(value) { return { verified: true, runId: value.runId, repoKey: value.repoKey,
        workspacePath: value.workspacePath, mode: 'read', adapterVersion: 'test', configDigest: 'test' }; } },
      skillRepoPath: 'agent-platform', skillCommitSha: reviewedSha, maxRunMs: 60_000,
      limits: { maxConcurrentRuns: 2, perRepoConcurrentRuns: 2, perAgentConcurrentRuns: 2, reservedHumanResume: 1 } });
    assert.equal(await manager.tick(), true);
    assert.equal(started, !conclusionFails);
    assert.equal(store.getTask('old-task')?.state, conclusionFails ? 'waiting_human' : 'investigating');
  } finally { if (api) await api.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
