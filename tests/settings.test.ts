import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, saveSettings } from '../src/api/settings.js';
import { SqliteStore } from '../src/storage/sqlite/store.js';
import { createKernelCoordinator } from '../src/agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../src/agent/router/candidate-finder.js';
import { startLocalApi } from '../src/api/local.js';
import { platformConfig, projectGroup, stage5PreflightRepositories } from '../src/bootstrap/config.js';
import { credential } from '../src/repository-ci/providers/http.js';
import { writeCodeHostToken } from '../src/bootstrap/code-host-credentials.js';
import { readQoderPat } from '../src/bootstrap/qoder-credentials.js';

test('Qoder PAT settings persist privately and are readable without restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-qoder-pat-'));
  const previous = process.env.AGENT_PLATFORM_QODER_PAT_PATH;
  const tokenFile = join(directory, 'qodercn.pat');
  process.env.AGENT_PLATFORM_QODER_PAT_PATH = tokenFile;
  const paths = { platform: 'config/platform.json', schedules: 'config/schedules.json' };
  try {
    const { revision } = readSettings(paths);
    assert.throws(() => saveSettings(paths, 'qoderPat', revision, { token: 'invalid token' }), /Invalid QoderCN PAT/);
    assert.equal(saveSettings(paths, 'qoderPat', revision, { token: 'fixture-qoder-pat' }).restartRequired, false);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(readQoderPat(), 'fixture-qoder-pat');
    const settings = readSettings(paths);
    assert.equal(settings.protected.qoderPatConfigured, true);
    assert.equal(JSON.stringify(settings).includes('fixture-qoder-pat'), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_PLATFORM_QODER_PAT_PATH;
    else process.env.AGENT_PLATFORM_QODER_PAT_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project group accepts only an optional local functional verification URL', () => {
  const base = { projectKey: 'cloudbom', repositories: [], verification: true };
  assert.equal(projectGroup.parse(base).functionalVerificationUrl, undefined);
  assert.equal(projectGroup.parse({ ...base, functionalVerificationUrl: 'http://127.0.0.1:8888' })
    .functionalVerificationUrl, 'http://127.0.0.1:8888');
  assert.equal(projectGroup.safeParse({ ...base, functionalVerificationUrl: 'https://example.com' }).success, false);
  assert.equal(projectGroup.safeParse({ ...base, functionalVerificationUrl: 'http://127.0.0.1:8888',
    verification: false }).success, false);
});

test('one project group token serves its repositories without exposing the token', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-code-host-token-'));
  const previous = process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH;
  const tokenFile = join(directory, 'code-host.json');
  process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH = tokenFile;
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json') };
  const raw = JSON.parse(readFileSync('config/platform.json', 'utf8'));
  raw.projectGroups[0].repositories.push({ ...raw.projectGroups[0].repositories[0],
    repoKey: 'second-repo', projectRef: 'MeMo9991/second-repo' });
  writeFileSync(paths.platform, JSON.stringify(raw));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  try {
    const before = readSettings(paths);
    assert.throws(() => saveSettings(paths, 'projectGroupToken', before.revision,
      { projectKey: 'unknown', token: 'secret-value' }), /Project group is not configured/);
    writeCodeHostToken('agent-platform', 'legacy-token');
    const saved = saveSettings(paths, 'projectGroupToken', before.revision,
      { projectKey: 'agent-platform', token: 'secret-value' });
    assert.equal(saved.restartRequired, true);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(readSettings(paths)).includes('secret-value'), false);
    assert.equal(JSON.stringify(readSettings(paths)).includes('credentialGroupKey'), false);
    assert.equal(readFileSync(paths.platform, 'utf8').includes('secret-value'), false);
    assert.equal(readSettings(paths).groups.projectGroups.find(item => item.projectKey === 'agent-platform')?.tokenConfigured, true);
    assert.equal('codeHostCredentials' in readSettings(paths).groups, false);
    const config = platformConfig.parse(JSON.parse(readFileSync(paths.platform, 'utf8')));
    assert.equal(credential(config.repositories.find(repo => repo.repoKey === 'agent-platform')!), 'secret-value');
    assert.equal(credential(config.repositories.find(repo => repo.repoKey === 'second-repo')!), 'secret-value');
    assert.deepEqual(stage5PreflightRepositories(config).map(repo => repo.repoKey).sort(),
      ['agent-platform', 'second-repo']);
    const groups = structuredClone(readSettings(paths).groups.projectGroups);
    groups.push({ projectKey: 'new-project', repositories: [], verification: false,
      tokenConfigured: false, searchRootConfigured: false });
    const added = saveSettings(paths, 'projectGroups', saved.revision, groups);
    assert.equal(readSettings(paths).groups.projectGroups.find(item => item.projectKey === 'new-project')?.tokenConfigured, false);
    saveSettings(paths, 'projectGroupToken', added.revision,
      { projectKey: 'new-project', token: 'new-project-token' });
    assert.equal(readSettings(paths).groups.projectGroups.find(item => item.projectKey === 'new-project')?.tokenConfigured, true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH;
    else process.env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  platform.projectGroups[0].verification = true;
  platform.projectGroups[1].searchRoot = '/private/secret/cloudbom';
  platform.projectGroups[1].defaultRepoKey = 'new-service';
  writeFileSync(paths.platform, JSON.stringify(platform));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  try {
    const before = readSettings(paths);
    assert.equal(JSON.stringify(before).includes('/private/secret'), false);
    const repos = before.groups.projectGroups[0].repositories;
    assert.equal(repos[0].localPath, undefined);
    assert.equal(repos[0].localPathConfigured, true);
    assert.equal(repos[0].credentialsRefConfigured, true);
    const service = before.groups.projectGroups[1].repositories[0];
    assert.deepEqual(service.autoPr, { enabled: false, allowedPrefixes: [] });
    assert.equal(service.credentialsRefConfigured, false);
    assert.equal(service.localPathConfigured, true);
    assert.equal(before.groups.projectGroups[0].searchRootConfigured, true);
    assert.equal(before.groups.projectGroups[0].verification, true);
    assert.equal(before.protected.credentialFileConfigured, true);
    const changed = structuredClone(before.groups.projectGroups);
    changed[0].repositories[0].targetBranch = 'develop';
    changed[0].repositories[0].localPath = undefined;
    changed[0].functionalVerificationUrl = 'http://127.0.0.1:8888';
    const saved = saveSettings(paths, 'projectGroups', before.revision, changed);
    assert.notEqual(saved.revision, before.revision);
    const persisted = JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>;
    assert.equal(persisted.projectGroups[0].repositories[0].localPath, '/private/secret/repository');
    assert.equal(persisted.projectGroups[0].repositories[0].credentialsRef, '/private/secret/repo-token');
    assert.equal(persisted.projectGroups[1].repositories[0].credentialsRef, 'unconfigured');
    assert.equal(persisted.projectGroups[1].repositories[0].localPath, '/private/secret/new-service');
    assert.equal(persisted.projectGroups[0].repositories[0].targetBranch, 'develop');
    assert.equal(persisted.projectGroups[0].verification, true);
    assert.equal(persisted.projectGroups[0].functionalVerificationUrl, 'http://127.0.0.1:8888');
    assert.deepEqual(persisted.interaction, platform.interaction);
    const groups = structuredClone(readSettings(paths).groups.projectGroups);
    groups[0].defaultRepoKey = 'agent-platform';
    const grouped = saveSettings(paths, 'projectGroups', saved.revision, groups);
    const groupedFile = JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>;
    assert.equal(groupedFile.projectGroups[0].searchRoot, '/private/secret/projects');
    assert.equal(groupedFile.projectGroups[0].defaultRepoKey, 'agent-platform');
    const renamed = structuredClone(readSettings(paths).groups.projectGroups);
    renamed[1].projectKey = 'devops-project-renamed';
    const renamedResult = saveSettings(paths, 'projectGroups', grouped.revision, renamed);
    assert.equal(JSON.parse(readFileSync(paths.platform, 'utf8')).projectGroups[1].searchRoot, '/private/secret/cloudbom');
    assert.equal(JSON.parse(readFileSync(paths.schedules, 'utf8')).tasks[0].projectKey, 'devops-project-renamed');
    assert.throws(() => saveSettings(paths, 'budget', before.revision, before.groups.budget), /version changed/);
    assert.throws(() => saveSettings(paths, 'port', renamedResult.revision, 70000));
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

test('settings explain a missing searchRoot instead of a generic validation error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-search-root-'));
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json') };
  const platform = JSON.parse(readFileSync('config/platform.json', 'utf8')) as Record<string, any>;
  writeFileSync(paths.platform, JSON.stringify(platform));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  try {
    const before = readSettings(paths);
    const groups = structuredClone(before.groups.projectGroups);
    groups[0].searchRootConfigured = true;
    assert.throws(() => saveSettings(paths, 'projectGroups', before.revision, groups),
      /reports searchRootConfigured but has no saved searchRoot/);

    assert.throws(() => saveSettings(paths, 'projectGroups', before.revision,
      [{ projectKey: 'group-without-root', repositories: [], defaultRepoKey: 'repo' }]),
      /Project group group-without-root sets defaultRepoKey without searchRoot/);

    const { credentialsRef: _credentials, ...repo } = platform.projectGroups[0].repositories[0];
    assert.throws(() => saveSettings(paths, 'projectGroups', before.revision,
      [{ projectKey: 'duplicate-repos', repositories: [repo, { ...repo }] }]),
      /Project group duplicate-repos has duplicate repository keys/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('settings API returns a readable validation error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-settings-error-'));
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json') };
  writeFileSync(paths.platform, readFileSync('config/platform.json'));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  const store = new SqliteStore(':memory:');
  const coordinator = createKernelCoordinator(store, {}, 'p1', 'test', 'qoder', ['agent-platform'], createTaskCandidateFinder(store));
  const credentialFile = join(directory, 'token');
  const server = await startLocalApi(store, coordinator, { credentialFile, actorId: 'owner', roles: ['configure'],
    dashboard: { actorId: 'owner', repoKeys: ['agent-platform'], imageDirectory: join(directory, 'images'),
      attachmentReaders: {}, settingsPaths: paths } });
  const headers = { authorization: `Bearer ${readFileSync(credentialFile, 'utf8')}`, 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const settings = await (await fetch(`${base}/api/settings`, { headers })).json() as Record<string, any>;
    const response = await fetch(`${base}/api/settings/projectGroups`, { method: 'PUT', headers,
      body: JSON.stringify({ expectedRevision: settings.revision, value: [
        { projectKey: 'group-without-root', repositories: [], defaultRepoKey: 'repo' }] }) });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /projectGroups\.0\.searchRoot: Project group group-without-root sets defaultRepoKey without searchRoot/);
    assert.doesNotMatch(body.error, /^\s*\[/);
  } finally { await server.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('review policy is readable and savable through the settings API', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-platform-review-'));
  const paths = { platform: join(directory, 'platform.json'), schedules: join(directory, 'schedules.json') };
  const platform = JSON.parse(readFileSync('config/platform.json', 'utf8')) as Record<string, any>;
  delete platform.review;
  writeFileSync(paths.platform, JSON.stringify(platform, null, 2));
  writeFileSync(paths.schedules, readFileSync('config/schedules.json'));
  try {
    const before = readSettings(paths);
    assert.equal((before.groups.review as { mode: string }).mode, 'shadow');
    const saved = saveSettings(paths, 'review', before.revision,
      { mode: 'warn', limits: { maxFiles: 5, maxChangedLines: 100 } });
    const persisted = JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>;
    assert.equal(persisted.review.mode, 'warn');
    assert.equal(persisted.review.limits.maxFiles, 5);
    assert.equal(persisted.review.gates.merge, 'human');
    assert.equal((readSettings(paths).groups.review as { mode: string }).mode, 'warn');
    assert.throws(() => saveSettings(paths, 'review', saved.revision, { mode: 'bogus' }), /invalid|Invalid|option/i);
    const latest = readSettings(paths);
    const removed = saveSettings(paths, 'review', latest.revision, null);
    assert.ok(removed.revision);
    assert.equal((JSON.parse(readFileSync(paths.platform, 'utf8')) as Record<string, any>).review, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
