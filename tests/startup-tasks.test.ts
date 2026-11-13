import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { checkAgentLinks, runStartupTasks } from '../src/bootstrap/startup-tasks.js';
import { platformConfig } from '../src/bootstrap/config.js';

test('only enabled agents are checked and Qoder status requires a username', async () => {
  const linked = await checkAgentLinks({ agents: [
    { kind: 'qoder', enabled: true }, { kind: 'qoder', enabled: false }],
    qoderPath: '/fake/qoder', statusRunner: async () => 'Version: 1.0\nUsername: owner\nEmail: x@example.test\n' });
  assert.equal(linked.length, 1);
  assert.equal(linked[0]?.linked, true);
  assert.equal(linked[0]?.detail, '已连接');

  const unlinked = await checkAgentLinks({ agents: [{ kind: 'qoder', enabled: true }],
    qoderPath: '/fake/qoder', statusRunner: async () => 'Version: 1.0\nLogin Method: browser\n' });
  assert.equal(unlinked[0]?.linked, false);

  const missing = await checkAgentLinks({ agents: [{ kind: 'qoder', enabled: true }],
    qoderPath: '/missing/qoder', statusRunner: async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    } });
  assert.equal(missing[0]?.linked, false);
  assert.match(missing[0]!.detail, /不存在/);

  const unknown = await checkAgentLinks({ agents: [{ kind: 'other', enabled: true }],
    qoderPath: '/fake/qoder', statusRunner: async () => 'Username: owner\n' });
  assert.equal(unknown[0]?.linked, false);
  assert.match(unknown[0]!.detail, /不支持/);
});

test('startup tasks combine workspace pruning and agent link status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-startup-tasks-'));
  const store = new SqliteStore(':memory:');
  try {
    const platform = platformConfig.parse({ repositories: [], projectGroups: [], sources: [],
      agents: [{ kind: 'qoder', enabled: true }], budget: { maxRunMs: 1000 }, policyRef: 'p1' });
    const result = await runStartupTasks({ platform, store, runtimeRoot: join(directory, 'runtime'),
      qoderPath: '/fake/qoder', retentionMs: 0, orphanGraceMs: 0,
      statusRunner: async () => 'Username: owner\n' });
    assert.equal(result.agents[0]?.linked, true);
    assert.equal(result.prune?.clonesDeleted, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
