import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createEventIngress } from '../src/event/ingress.js';
import { createDefectSource, defectMetadataFields, normalizeDefect, parseDefectDetail, parseDescription } from '../src/event/sources/devops/defects.js';
import { createDefectApiReaders } from '../src/event/sources/devops/client.js';
import { createDevopsAttachmentReader } from '../src/event/sources/devops/attachment.js';
import { pollSource } from '../src/event/poll.js';
import { startConfiguredSchedules } from '../src/bootstrap/start-schedules.js';
import { loadScheduleConfig } from '../src/bootstrap/scheduler.js';

const config = { sourceId: 'devops-assigned', businessProjectId: 4655971863, pageSize: 2 };
const item = (id: number) => ({ id, subject: `缺陷 ${id}`, businessProjectId: config.businessProjectId,
  type: 'defect', statusId: 3166016, description: null, descriptionId: `description-${id}`,
  gmtCreated: '2026-11-04 18:43:27', gmtModified: '2026-11-04 18:43:27', priority: 'HIGH', environment: 'uat' });
const imageUrl = 'https://devops.faw.cn/api/document/fileRelation/getRelatedFile/0390cd20012045eabb6f934eb3bb5432/f2588fdaaacd4f7d975e615e64ec03d0';
const description = JSON.stringify(['root', {},
  ['p', {}, ['span', {}, '[缺陷描述]：'], ['span', {}, '中文详情']],
  ['p', {}, ['img', { src: imageUrl }]],
  ['p', {}, ['span', {}, '[重现步骤]：'], ['span', {}, '点击按钮']]]);
const page = (pageNum: number, list: ReturnType<typeof item>[], total = 3) => ({ code: '200', success: true,
  data: { pageNum, pageSize: 2, total, list } });
const detail = (id: number) => ({ code: '200', success: true, data: { ...item(id), description } });

test('detail adapter extracts visible text and opaque image reference', () => {
  const parsed = parseDefectDetail(detail(1), 1, config.businessProjectId);
  const event = normalizeDefect(parsed.item, config, parsed.description);
  assert.equal(event.title, '缺陷 1');
  assert.equal(event.body, '[缺陷描述]：中文详情\n[重现步骤]：点击按钮');
  assert.deepEqual(event.attachments, [{ id: 'f2588fdaaacd4f7d975e615e64ec03d0', kind: 'image',
    sourceRef: 'devops-file/0390cd20012045eabb6f934eb3bb5432/f2588fdaaacd4f7d975e615e64ec03d0' }]);
  assert.equal(event.repoKey, undefined);
  assert.equal(event.metaData.descriptionId, 'description-1');
  assert.equal(event.revision, normalizeDefect(parsed.item, config, parsed.description).revision);
  assert.notEqual(event.revision, normalizeDefect({ ...parsed.item, subject: '修改后的缺陷' }, config, parsed.description).revision);
  assert.throws(() => parseDefectDetail(detail(1), 2, config.businessProjectId));
  assert.throws(() => parseDescription(JSON.stringify(['img', { src: 'https://evil.example/file' }])));
});

test('two-page scan persists pending events, deduplicates repeats and recovers after a failed page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-devops-'));
  const path = join(directory, 'events.sqlite3');
  const metadata = { [config.sourceId]: [...defectMetadataFields] };
  let failPageTwo = true;
  try {
    const store = new SqliteStore(path, metadata);
    store.registerSource(config.sourceId, 'devops-defect', 'devops-assigned-config', true);
    const ingress = createEventIngress(store, metadata);
    const source = createDefectSource(config,
      async number => {
        if (number === 2 && failPageTwo) throw new Error('page two failed');
        return number === 1 ? page(1, [item(1), item(2)]) : page(2, [item(3)]);
      }, async id => detail(id));
    await assert.rejects(pollSource(source, ingress), /page two failed/);
    assert.equal(store.listPending(10).length, 2);
    failPageTwo = false;
    assert.equal(await pollSource(source, ingress), 3);
    assert.equal(store.listPending(10).length, 3);
    assert.equal(await pollSource(source, ingress), 3);
    assert.equal(store.listPending(10).length, 3);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task').get()?.n, 0);
    store.close();
    const reopened = new SqliteStore(path, metadata);
    const pending = reopened.listPending(10);
    assert.equal(pending.length, 3);
    assert.equal(reopened.get(pending[0]!.id)?.body, '[缺陷描述]：中文详情\n[重现步骤]：点击按钮');
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP readers send list and detail requests without storing credentials', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const request: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: headers.get('Authorization') });
    return new Response(JSON.stringify({ code: '200', success: true }), { status: 200 });
  };
  const readers = createDefectApiReaders(config, async () => ({ Authorization: 'Bearer test-only' }), request);
  await readers.readPage(1);
  await readers.readDetail(11406133);
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['list', 'query']);
  assert.equal(calls[0]?.body.pageNum, 1);
  assert.equal(calls[1]?.body.itemId, 11406133);
  assert.equal(calls[1]?.body.businessProjectId, String(config.businessProjectId));
  assert.equal(calls[0]?.auth, 'Bearer test-only');
  await assert.rejects(createDefectApiReaders(config, async () => ({}), request).readPage(1), /authorization is unavailable/);
});

test('image reader only opens validated same-source references with bounded image content', async () => {
  const ref = parseDescription(description).attachments[0]!;
  const reader = createDevopsAttachmentReader(config.sourceId, async () => ({ Authorization: 'Bearer test-only' }),
    async (input, init) => {
      assert.equal(String(input), imageUrl);
      assert.equal(init?.redirect, 'error');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    });
  const stream = await reader.open(config.sourceId, ref);
  const chunks: number[] = [];
  for await (const chunk of stream) chunks.push(...chunk);
  assert.deepEqual(chunks, [1, 2, 3]);
  await assert.rejects(reader.open('other-source', ref));
  await assert.rejects(reader.open(config.sourceId, { ...ref, sourceRef: 'https://evil.example/file' }));
});

test('configured DevOps task starts and reads list and detail through the registered handler', async () => {
  const scheduled = { ...loadScheduleConfig('config/schedules.json').tasks[0]!, enabled: true, runOnStart: true };
  assert.equal(scheduled.intervalSeconds, 300);
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-runtime-'));
  const repoPath = join(directory, 'repo');
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', repoPath]);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/MeMo9991/agent-platform.git']);
  const platform = JSON.parse(readFileSync('config/platform.json', 'utf8'));
  const repo = platform.projectGroups[0].repositories.pop();
  repo.localPath = repoPath;
  platform.projectGroups[1] = { projectKey: 'devops-project-cloudbom', repositories: [repo],
    defaultRepoKey: 'agent-platform', searchRoot: directory };
  const platformPath = join(directory, 'platform.json');
  writeFileSync(platformPath, JSON.stringify(platform));
  const schedulePath = join(directory, 'schedules.json');
  writeFileSync(schedulePath, JSON.stringify({ tasks: [scheduled] }));
  const paths: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const path = String(input).split('/').at(-1)!;
    paths.push(path);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only');
    return Response.json(path === 'list' ? { code: '200', success: true,
      data: { pageNum: 1, pageSize: 10, total: 1, list: [item(11406133)] } } : detail(11406133));
  };
  try {
    const runtime = startConfiguredSchedules({ platform: platformPath, schedules: schedulePath,
      database: join(directory, 'events.sqlite3') }, async () => ({ Authorization: 'Bearer test-only' }),
    error => { throw error; }, request);
    await runtime.stop();
    assert.deepEqual(paths, ['list', 'query']);
    const reopened = new SqliteStore(join(directory, 'events.sqlite3'), { [config.sourceId]: defectMetadataFields });
    assert.deepEqual(reopened.listPending(10).map(event => [event.externalId, event.repoKey,
      event.metaData.repositorySelection]), [['11406133', 'agent-platform', 'default']]);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
