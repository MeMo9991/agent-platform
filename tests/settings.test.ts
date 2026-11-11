import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, saveSettings } from '../src/api/settings.js';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from '../src/agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../src/agent/router/candidate-finder.js';
import { startLocalApi } from '../src/api/local.js';

test('settings save validates groups, preserves trust roots and hides local paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-settings-'));
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json') };
  const platform = JSON.parse(readFileSync('config/platform.json', 'utf8')) as Record<string, any>;
  platform.projectGroups[0].repositories[0].localPath = '/private/secret/repository';
  platform.projectGroups[0].repositories[0].credentialsRef = '/private/secret/repo-token';
  platform.projectGroups[1].repositories.push({ repoKey: 'new-service', provider: 'gitlab', hostUrl: 'https://git.example',
    projectRef: 'team/new-service', targetBranch: 'master', requiredChecks: [], localChecks: [],
    credentialsRef: 'unconfigured', localPath: '/private/secret/new-service' });
  platform.interaction.credentialFile = '/private/secret/token';
  platform.projectGroups[0].searchRoot = '/private/secret/projects';
  writeFileSync(paths.platform, JSON.stringify(platform));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  try {
    const before = readSettings(paths);
    assert.equal(JSON.stringify(before).includes('/private/secret'), false);
    assert.equal(before.groups.repositories[0].localPath, undefined);
    assert.equal(before.groups.repositories[0].localPathConfigured, true);
    assert.equal(before.groups.repositories[0].credentialsRefConfigured, true);
    assert.equal(before.groups.projectGroups[0].searchRootConfigured, true);
    assert.equal(before.protected.credentialFileConfigured, true);
    const changed = structuredClone(before.groups.projectGroups);
    changed[0].repositories[0].targetBranch = 'develop';
    changed[0].repositories[0].localPath = undefined;
    const saved = saveSettings(paths, 'projectGroups', before.revision, changed);
    assert.notEqual(saved.revision, before.revision);
    const persisted = JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>;
    assert.equal(persisted.projectGroups[0].repositories[0].localPath, '/private/secret/repository');
    assert.equal(persisted.projectGroups[0].repositories[0].credentialsRef, '/private/secret/repo-token');
    assert.equal(persisted.projectGroups[1].repositories[0].credentialsRef, 'unconfigured');
    assert.equal(persisted.projectGroups[1].repositories[0].localPath, '/private/secret/new-service');
    assert.equal(persisted.projectGroups[0].repositories[0].targetBranch, 'develop');
    assert.deepEqual(persisted.interaction, platform.interaction);
    const groups = structuredClone(before.groups.projectGroups);
    groups[0].repoKeys = ['agent-platform'];
    const grouped = saveSettings(paths, 'projectGroups', saved.revision, groups);
    const groupedFile = JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>;
    assert.equal(groupedFile.projectGroups[0].searchRoot, '/private/secret/projects');
    assert.deepEqual(groupedFile.projectGroups[0].repoKeys, ['agent-platform']);
    assert.throws(() => saveSettings(paths, 'budget', before.revision, before.groups.budget), /version changed/);
    assert.throws(() => saveSettings(paths, 'port', grouped.revision, 70000));
    assert.equal((JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>).interaction.port, platform.interaction.port);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('settings API requires a separately configured role', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-settings-api-'));
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json') };
  writeFileSync(paths.platform, readFileSync('config/platform.json'));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  const store = new SqliteStore(':memory:');
  const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['agent-platform'], createTaskCandidateFinder(store));
  const run = async (roles: Array<'answer' | 'configure'>) => {
    const credentialFile = join(directory, `token-${roles.join('-')}`);
    const server = await startLocalApi(store, coordinator, { credentialFile, actorId: 'owner', roles,
      dashboard: { actorId: 'owner', repoKeys: ['agent-platform'], imageDirectory: join(directory, 'images'),
        attachmentReaders: {}, settingsPaths: paths } });
    const headers = { authorization: `Bearer ${readFileSync(credentialFile, 'utf8')}`, 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const get = await fetch(`${base}/api/settings`, { headers });
      const put = await fetch(`${base}/api/settings/budget`, { method: 'PUT', headers,
        body: JSON.stringify({ expectedRevision: 'a'.repeat(64), value: { maxRunMs: 1000 } }) });
      return { get, put, body: await get.json() as Record<string, any> };
    } finally { await server.stop(); }
  };
  try {
    const denied = await run(['answer']);
    assert.equal(denied.get.status, 409);
    assert.equal(denied.put.status, 409);
    const allowed = await run(['configure']);
    assert.equal(allowed.get.status, 200);
    assert.equal(allowed.put.status, 409); // stale revision still blocks an authorized writer
    assert.ok(allowed.body.groups.budget);
    assert.equal(JSON.stringify(allowed.body).includes('local-api.token'), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
