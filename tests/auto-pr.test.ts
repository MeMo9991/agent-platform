import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { autoPrDiffAllowed, autoPrMandate, autoPrPathsAllowed, autoPrRuleRef } from '../src/authorization/auto-pr.js';
import { createStage5OpenChange } from '../src/authorization/stage5-open-change.js';
import { createEventLoop } from '../src/agent/kernel/event-loop.js';
import { createKernelCoordinator } from '../src/agent/kernel/coordinator.js';
import { startLocalApi } from '../src/api/local.js';
import type { CodeHost } from '../src/repository-ci/model.js';

const repo = { repoKey: 'agent-platform', provider: 'github' as const, hostUrl: 'https://github.com',
  projectRef: 'team/repo', targetBranch: 'main', requiredChecks: ['verify'],
  credentialsRef: 'env:TEST_TOKEN', localChecks: [],
  autoPr: { enabled: true, allowedPrefixes: ['src/', 'tests/', 'web/src/'] as Array<'src/' | 'tests/' | 'web/src/'> } };
const event = { id: 'event', sourceId: 'manual:agent-platform', externalId: '1', revision: '1',
  kind: 'manual_task', title: '修改 src/feature.ts', body: '修改 src/feature.ts',
  repoKey: 'agent-platform', attachments: [], metaData: { autoPr: true },
  status: 'pending' as const, receivedAt: new Date().toISOString() };

test('automatic PR authority requires explicit opt-in and the first trusted scope', () => {
  assert.equal(autoPrMandate(event, repo, 'v1')?.allowedActions.join(','), 'investigate,edit,open_pr');
  assert.equal(autoPrMandate({ ...event, metaData: {} }, repo, 'v1'), undefined);
  assert.equal(autoPrMandate({ ...event, body: '只读，修改 src/feature.ts' }, repo, 'v1'), undefined);
  assert.equal(autoPrMandate({ ...event, body: '仅新增 src/feature.ts，不要修改任何现有文件' }, repo, 'v1')?.authority.kind, 'auto_pr');
  assert.equal(autoPrMandate({ ...event, sourceId: 'external' }, repo, 'v1'), undefined);
  assert.equal(autoPrMandate(event, { ...repo, repoKey: 'other' }, 'v1'), undefined);
  assert.equal(autoPrMandate(event, { ...repo, autoPr: { ...repo.autoPr, enabled: false } }, 'v1'), undefined);
  assert.equal(autoPrPathsAllowed(['src/feature.ts', 'tests/feature.test.ts'], repo), true);
  for (const path of ['README.md', 'src/auth.ts', 'src/authorization/gate.ts',
    'src/security/check.ts', 'src/release.ts', '.github/workflows/verify.yml'])
    assert.equal(autoPrPathsAllowed([path], repo), false, path);
  assert.equal(autoPrDiffAllowed('+const apiKey = "fixture";\n'), false);
  assert.equal(autoPrDiffAllowed('+export const feature = 2;\n'), true);
});

test('trusted manual event routes to an automatic PR Task without changing default intake', () => {
  for (const optedIn of [true, false]) {
    const store = new SqliteStore(':memory:', { [event.sourceId]: ['autoPr'] });
    try {
      store.registerSource(event.sourceId, 'manual', 'fixture', true);
      const { id: _id, status: _status, receivedAt: _receivedAt, ...incoming } = event;
      store.accept({ ...incoming, metaData: { autoPr: optedIn } });
      const loop = createEventLoop(store, { [event.sourceId]: repo.repoKey }, 'v1', 'intake', 'qoder',
        { find: () => ({ candidates: [], complete: true }) }, 60_000,
        source => autoPrMandate(source, repo, 'v1'));
      assert.equal(loop.processOne(), true);
      const row = store.db.prepare('SELECT id FROM task').get();
      assert.ok(row);
      assert.equal(store.getTask(String(row.id))?.mandate.authority.kind,
        optedIn ? 'auto_pr' : 'trusted_rule');
    } finally { store.close(); }
  }
});

test('human routing a similar opt-in event to a new Task preserves its automatic scope', () => {
  const store = new SqliteStore(':memory:', { [event.sourceId]: ['autoPr'] });
  try {
    store.registerSource(event.sourceId, 'manual', 'fixture', true);
    const { id: _id, status: _status, receivedAt: _receivedAt, ...incoming } = event;
    const { eventId } = store.accept(incoming);
    const coordinator = createKernelCoordinator(store, { [event.sourceId]: repo.repoKey }, 'v1', 'intake',
      'qoder', [repo.repoKey], { find: () => ({ candidates: [{ taskId: 'similar', evidence: [] }], complete: true }) },
      source => autoPrMandate(source, repo, 'v1'));
    assert.equal(coordinator.processPending(), 1);
    assert.equal(store.get(eventId)?.status, 'needs_human');
    const taskId = coordinator.resolveHumanRoute({ choice: 'new_task', eventId, repoKey: repo.repoKey,
      actor: { kind: 'human', id: 'owner' }, at: new Date().toISOString(),
      idempotencyKey: 'separate-task', reason: 'A separate, scoped change' });
    assert.equal(store.getTask(taskId!)?.mandate.authority.kind, 'auto_pr');
  } finally { store.close(); }
});

test('submission API accepts the opt-in only for an enabled repository without attachments', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auto-pr-api-'));
  const store = new SqliteStore(':memory:', { [event.sourceId]: ['contentDigest', 'autoPr'] });
  store.registerSource(event.sourceId, 'manual', 'fixture', true);
  const coordinator = createKernelCoordinator(store, { [event.sourceId]: repo.repoKey }, 'v1', 'intake',
    'qoder', [repo.repoKey], { find: () => ({ candidates: [], complete: true }) },
    source => autoPrMandate(source, repo, 'v1'));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['submit'], dashboard: { actorId: 'owner', repoKeys: [repo.repoKey],
        autoPrRepoKeys: [repo.repoKey], imageDirectory: join(directory, 'images'), attachmentReaders: {} } });
    const token = readFileSync(join(directory, 'token'), 'utf8');
    const submit = async (body: object) => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/events`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repoKey: repo.repoKey, body: event.body, idempotencyKey: crypto.randomUUID(), ...body }) });
      return response.status;
    };
    assert.equal(await submit({ autoPr: true, images: [{ data: 'x', mimeType: 'image/png' }] }), 409);
    assert.equal(await submit({ autoPr: true }), 202);
    coordinator.processPending();
    const row = store.db.prepare('SELECT id FROM task').get();
    assert.equal(store.getTask(String(row?.id))?.mandate.authority.kind, 'auto_pr');
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('verified ordinary diff opens PR without action approval while merge still needs scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auto-pr-'));
  const store = new SqliteStore(':memory:', { [event.sourceId]: ['autoPr'] });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const at = new Date().toISOString();
  const targetSha = 'b'.repeat(40);
  try {
    mkdirSync(join(directory, 'src'));
    git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
    writeFileSync(join(directory, 'src/feature.ts'), 'export const feature = 1;\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'src/feature.ts'), 'export const feature = 2;\n');
    git('add', '.'); git('commit', '-qm', 'change');
    const sourceSha = git('rev-parse', 'HEAD');
    store.registerSource(event.sourceId, 'manual', 'fixture', true);
    const { id: _id, status: _status, receivedAt: _receivedAt, ...incoming } = event;
    const { eventId } = store.accept(incoming);
    store.claimEvent(at, new Date(Date.now() + 60_000).toISOString());
    store.saveTask({ id: 'task', originEventId: eventId, repoKey: repo.repoKey, title: event.title, scope: event.body,
      state: 'ready_to_merge', iteration: 1, priority: 0, baseRef: baseSha, createdAt: at, updatedAt: at,
      mandate: { ...autoPrMandate({ ...event, id: eventId }, repo, 'v1')! } });
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
    let pushes = 0;
    const host: CodeHost = { repoKey: repo.repoKey, provider: 'github',
      async readTarget() { return targetSha; }, async readChecks() { return []; },
      async readRequiredChecks() { return ['verify']; }, async findChangeByBranch() { return undefined; },
      async openChange() { return { provider: 'github', repoKey: repo.repoKey, id: '2', sourceSha, targetSha }; },
      async readChange(change) { return { change, state: 'open', sourceSha, targetSha,
        checks: [{ repoKey: repo.repoKey, commitSha: sourceSha, name: 'verify',
          status: 'completed', conclusion: 'success' }], gate: 'ready', observedAt: at }; },
      async merge() { throw new Error('Merge must stay manual'); } };
    const service = createStage5OpenChange(store, { [repo.repoKey]: repo }, { [repo.repoKey]: host },
      { async prepare() { throw new Error('unexpected'); }, async verifyAfterChecks() {} },
      'v1', async () => { pushes++; });
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get('task')?.version);
    assert.equal(store.hasActionApproval({ taskId: 'task', action: 'open_pr', sourceSha,
      targetBranch: 'main', targetSha, policyVersion: 'v1' }), false);
    assert.equal((await service.prepare('task', version)).kind, 'ready');
    assert.deepEqual(await service.execute('task', version), { kind: 'opened', changeId: '2' });
    assert.equal(pushes, 1);
    assert.equal((await service.prepareMerge('task', version)).kind, 'scope_request');
    assert.equal(autoPrRuleRef({ ...repo, autoPr: { ...repo.autoPr, enabled: false } }, 'v1'), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
