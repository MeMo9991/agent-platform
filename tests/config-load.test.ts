import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewConfigMigration } from '../src/bootstrap/config/migrate.js';
import { readConfigDocuments } from '../src/bootstrap/config/documents.js';
import { loadConfiguration } from '../src/bootstrap/config/load.js';
import { readSettings } from '../src/api/settings.js';

test('new instances can load defaults without creating configuration or runtime files', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-config-'));
  try {
    const loaded = loadConfiguration(root, {});
    assert.equal(loaded.platform.interaction?.port, 8765);
    assert.deepEqual(loaded.platform.agents, []);
    assert.deepEqual(loaded.platform.projectGroups, []);
    assert.deepEqual(loaded.schedules.tasks, []);
    assert.deepEqual(loaded.capabilities, { stage5Worker: false, qoderWrite: false, stage5Writes: false });
    assert.equal(loaded.database, join(root, '.runtime/state/agent-platform.sqlite3'));
    assert.equal(existsSync(loaded.runtimeRoot), false);
    assert.equal(existsSync(join(root, '.env')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local configuration inherits defaults and settings distinguishes saved edits from the running snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-config-'));
  try {
    mkdirSync(join(root, 'config'));
    const local = join(root, 'config/local.yaml');
    writeFileSync(local, `# Per-machine settings
instance:
  runtimeRoot: local state
maintenance:
  workspaceRetentionDays: 0
platform:
  agents:
    - kind: qoder
      enabled: true
      model: auto
  interaction:
    port: 8766
  budget:
    maxRunMs: 1000
`);
    const active = loadConfiguration(root, {});
    assert.deepEqual(active.platform.agents, [{ kind: 'qoder', enabled: true, model: 'auto' }]);
    assert.equal(active.platform.interaction?.port, 8766);
    assert.equal(active.platform.budget.maxConcurrentRuns, 2);
    assert.equal(active.database, join(root, 'local state/state/agent-platform.sqlite3'));
    assert.equal(active.workspaceRetentionMs, 0);
    assert.throws(() => loadConfiguration(root, { AGENT_PLATFORM_CONFIG: 'old.json' }), /conflicts with AGENT_PLATFORM_CONFIG/);
    assert.throws(() => loadConfiguration(root, { AGENT_PLATFORM_RUNTIME_ROOT: 'other' }), /conflicts with AGENT_PLATFORM_RUNTIME_ROOT/);

    writeFileSync(local, JSON.stringify({ platform: { interaction: { port: 8767 } } }));
    const settings = readSettings(active.paths, { active });
    assert.equal(settings.configurationSource, 'local');
    assert.equal(settings.configurationFile, 'config/local.yaml');
    assert.equal(settings.pendingRestart, true);
    assert.equal(settings.groups.instance.port, 8766);
    assert.deepEqual(settings.groups.agents, active.platform.agents);
    assert.equal(settings.groups.review, null);
    writeFileSync(local, JSON.stringify({ platform: { budget: 'invalid' } }));
    assert.throws(() => loadConfiguration(root, {}), /Invalid configuration/);
    assert.equal(readSettings(active.paths, { active }).groups.instance.port, 8766);
    assert.match(readSettings(active.paths, { active }).configurationError!, /Invalid configuration/);
    writeFileSync(local, 'platform:\n  agents:\n    - kind: qoder\n      enabled: true\n      model: --version\n');
    assert.throws(() => loadConfiguration(root, {}), /Invalid agent model name/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy .env config and explicit legacy launches use their own files and capabilities', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-config-'));
  try {
    writeFileSync(join(root, '.env'),
      'AGENT_PLATFORM_CONFIG=old.json\nAGENT_PLATFORM_SCHEDULES=old-schedules.json\nAGENT_PLATFORM_STAGE5_WORKER_ENABLED=1\n');
    writeFileSync(join(root, 'old.json'), JSON.stringify({ agents: [], budget: { maxRunMs: 1000 }, policyRef: 'legacy' }));
    writeFileSync(join(root, 'old-schedules.json'), '{"tasks":[]}');
    assert.equal(loadConfiguration(root, {}).capabilities.stage5Worker, true);
    const explicit = loadConfiguration(root, { AGENT_PLATFORM_CONFIG: 'old.json',
      AGENT_PLATFORM_SCHEDULES: 'old-schedules.json', AGENT_PLATFORM_RUNTIME_ROOT: 'legacy-data' });
    assert.equal(explicit.platform.policyRef, 'legacy');
    assert.equal(explicit.capabilities.stage5Worker, false);
    assert.equal(explicit.database, join(root, 'legacy-data/state/agent-platform.sqlite3'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration preserves effective legacy settings without serializing credential values', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-config-migration-'));
  try {
    const platformFile = join(root, 'old.json');
    const scheduleFile = join(root, 'old-schedules.json');
    const repository = { repoKey: 'app', provider: 'github', hostUrl: 'https://github.com',
      projectRef: 'team/app', targetBranch: 'main', credentialsRef: 'env:APP_TOKEN', localPath: '.' };
    const legacy = { agents: [], budget: { maxRunMs: 1000 }, policyRef: 'legacy', skills: ['ignored'],
      projectGroups: [{ projectKey: 'agent-platform', repositories: [repository], verification: true }] };
    writeFileSync(platformFile, JSON.stringify(legacy));
    writeFileSync(scheduleFile, JSON.stringify({ tasks: [{ id: 'existing-scan', kind: 'github-pr-poll',
      projectKey: 'agent-platform', enabled: false, runOnStart: false, intervalSeconds: 60 }] }));
    const env = { AGENT_PLATFORM_CONFIG: platformFile, AGENT_PLATFORM_SCHEDULES: scheduleFile,
      AGENT_PLATFORM_STAGE5_WRITES_ENABLED: '1', AGENT_PLATFORM_DATABASE: 'keep.sqlite3',
      AGENT_PLATFORM_QODER_PAT_PATH: 'pat.file', APP_TOKEN: 'test-secret-value' };
    const original = loadConfiguration(root, env);
    const preview = previewConfigMigration(root, original);
    assert.deepEqual(preview.ignored, ['skills']);
    assert.deepEqual(preview.requiredEnvironment, ['APP_TOKEN']);
    assert.equal(preview.yaml.includes('test-secret-value'), false);
    const local = join(root, 'config/local.yaml');
    assert.equal(existsSync(local), false);
    assert.throws(() => readConfigDocuments({ local }, JSON.stringify({ platform: legacy })), /Unknown platform setting skills/);
    assert.throws(() => readConfigDocuments({ local }, JSON.stringify({
      platform: { projectGroups: legacy.projectGroups },
    })), /must set verification.type/);
    mkdirSync(join(root, 'config'));
    writeFileSync(local, preview.yaml);
    const migrated = loadConfiguration(root, { APP_TOKEN: env.APP_TOKEN });
    assert.deepEqual(migrated.platform, original.platform);
    assert.deepEqual(migrated.schedules, original.schedules);
    assert.deepEqual(migrated.capabilities, original.capabilities);
    assert.equal(migrated.database, original.database);
    assert.equal(migrated.env.AGENT_PLATFORM_QODER_PAT_PATH, original.env.AGENT_PLATFORM_QODER_PAT_PATH);
    rmSync(local);
    writeFileSync(platformFile, JSON.stringify({ ...legacy,
      projectGroups: [{ projectKey: 'unmapped-group', verification: true }],
    }));
    writeFileSync(scheduleFile, '{"tasks":[]}');
    assert.throws(() => previewConfigMigration(root, loadConfiguration(root, env)), /Choose verification.type.*unmapped-group/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('legacy local JSON migrates to YAML and startup rejects both formats together', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-platform-config-format-'));
  try {
    mkdirSync(join(root, 'config'));
    const json = join(root, 'config/local.json');
    const yaml = join(root, 'config/local.yaml');
    writeFileSync(json, JSON.stringify({ platform: { policyRef: 'on', interaction: false } }));
    const legacy = loadConfiguration(root, {});
    assert.deepEqual(legacy.paths, { local: json });
    assert.equal(readSettings(legacy.paths).configurationFile, 'config/local.json');
    writeFileSync(yaml, previewConfigMigration(root, legacy).yaml);
    assert.throws(() => loadConfiguration(root, {}), /local.yaml and config\/local.json both exist/);
    rmSync(json);
    const migrated = loadConfiguration(root, {});
    assert.deepEqual(migrated.paths, { local: yaml });
    assert.deepEqual(migrated.platform, legacy.platform);
    assert.deepEqual(migrated.local, legacy.local);
    writeFileSync(yaml, '# Initially empty\n');
    assert.equal(loadConfiguration(root, {}).platform.interaction?.port, 8765);
    writeFileSync(yaml, 'capabilities:\n  stage5Writes: false\n  stage5Writes: true\n');
    assert.throws(() => loadConfiguration(root, {}), /Map keys must be unique/);
    writeFileSync(yaml, 'platform: &platform {}\ntools: *platform\n');
    assert.throws(() => loadConfiguration(root, {}), /alias/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
