import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from '../src/agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../src/agent/router/candidate-finder.js';
import { startLocalApi } from '../src/api/local.js';

test('manual submission chooses a project group, auto-selects its repository and rejects cross-group choices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-manual-group-'));
  const store = new SqliteStore(':memory:', {
    'manual:agent-platform': ['contentDigest'], 'manual:bommgmt': ['contentDigest'], 'manual:ui': ['contentDigest'] });
  for (const key of ['agent-platform', 'bommgmt', 'ui']) store.registerSource(`manual:${key}`, 'manual', key, true);
  const coordinator = createKernelCoordinator(store, {
    'manual:agent-platform': 'agent-platform', 'manual:bommgmt': 'bommgmt', 'manual:ui': 'ui',
  }, 'p1', 'manual', 'qoder', ['agent-platform', 'bommgmt', 'ui'], createTaskCandidateFinder(store));
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['submit'], dashboard: { actorId: 'owner',
        repoKeys: ['agent-platform', 'bommgmt', 'ui'], imageDirectory: join(directory, 'images'), attachmentReaders: {},
        projectGroups: { 'agent-platform': { repoKeys: ['agent-platform'] },
          cloudbom: { repoKeys: ['bommgmt', 'ui'], defaultRepoKey: 'bommgmt' } },
        selectRepositoryByGroup: { cloudbom: (_title, body) => ({ repoKey: body.includes('UI') ? 'ui' : 'bommgmt' }) },
      } });
    const token = readFileSync(join(directory, 'token'), 'utf8');
    const submit = async (value: object) => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/events`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'UI 页面错误', idempotencyKey: crypto.randomUUID(), ...value }) });
      return { status: response.status, value: await response.json() as { eventId?: string } };
    };
    const selected = await submit({ projectKey: 'cloudbom' });
    assert.equal(selected.status, 202);
    assert.deepEqual([store.get(selected.value.eventId!)?.sourceId, store.get(selected.value.eventId!)?.repoKey],
      ['manual:ui', 'ui']);
    const single = await submit({ projectKey: 'agent-platform' });
    assert.equal(single.status, 202);
    assert.equal(store.get(single.value.eventId!)?.repoKey, 'agent-platform');
    assert.equal((await submit({ projectKey: 'cloudbom', repoKey: 'agent-platform' })).status, 409);
  } finally { await server?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
