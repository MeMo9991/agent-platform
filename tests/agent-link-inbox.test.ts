import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { startLocalApi } from '../src/api/local.js';
import { createKernelCoordinator } from './kernel-fixture.js';

test('unlinked enabled agents are exposed as inbox notices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-link-inbox-'));
  const store = new SqliteStore(':memory:');
  let server: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['repo']);
    server = await startLocalApi(store, coordinator, { credentialFile: join(directory, 'token'),
      actorId: 'owner', roles: ['route'], dashboard: { actorId: 'owner', repoKeys: ['repo'],
        imageDirectory: join(directory, 'images'), attachmentReaders: {},
        agentLinks: [
          { kind: 'qoder', linked: false, detail: 'Qoder CLI 未登录或无法确认账号', checkedAt: new Date().toISOString() },
          { kind: 'other', linked: true, detail: '已连接', checkedAt: new Date().toISOString() },
        ] } });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox`, { headers: {
      authorization: `Bearer ${readFileSync(join(directory, 'token'), 'utf8')}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { notices: { id: string; title: string; detail: string }[] };
    assert.equal(body.notices.length, 1);
    assert.equal(body.notices[0]?.id, 'agent-link:qoder');
    assert.match(body.notices[0]?.title ?? '', /qoder/);
    assert.match(body.notices[0]?.detail ?? '', /未登录/);
  } finally {
    await server?.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
