import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { platformConfig, type PlatformConfig } from '../bootstrap/config.js';
import { scheduleConfig, type ScheduleConfig } from '../bootstrap/scheduler.js';
import { validateScheduledSources } from '../bootstrap/start-schedules.js';
import { devopsCredentials, readCredentials, writeCredentials, credentialsExist } from '../bootstrap/devops-credentials.js';
import { reviewConfig } from '../authorization/policy/config.js';

export const settingsGroup = z.enum(['projectGroups', 'schedules', 'agents', 'budget', 'policyRef', 'releasePipelines', 'port', 'review', 'devopsCredentials']);
export type SettingsGroup = z.infer<typeof settingsGroup>;
export type SettingsPaths = { platform: string; schedules: string };

type Loaded = { platform: PlatformConfig; platformRaw: Record<string, unknown>; schedules: ScheduleConfig;
  revision: string; platformBytes: string; scheduleBytes: string };
function load(paths: SettingsPaths): Loaded {
  const platformBytes = readFileSync(paths.platform, 'utf8');
  const scheduleBytes = readFileSync(paths.schedules, 'utf8');
  const platformRaw = JSON.parse(platformBytes) as Record<string, unknown>;
  return { platform: platformConfig.parse(platformRaw), platformRaw,
    schedules: scheduleConfig.parse(JSON.parse(scheduleBytes)),
    revision: createHash('sha256').update(platformBytes).update('\0').update(scheduleBytes).digest('hex'),
    platformBytes, scheduleBytes };
}
function validatePair(platform: PlatformConfig, schedules: ScheduleConfig): void {
  validateScheduledSources(platform, schedules);
  if (!platform.agents.some(agent => agent.kind === 'qoder') ||
      platform.agents.some(agent => agent.enabled && agent.kind !== 'qoder'))
    throw new Error('Only Qoder is available in this stage');
}
function publicRepositories(repositories: PlatformConfig['repositories']) {
  return repositories.map(repo => {
    const { credentialsRef: _protected, ...visible } = repo;
    void _protected;
    return { ...visible,
    autoPr: repo.autoPr ?? { enabled: false, allowedPrefixes: [] },
    localPath: repo.localPath && !isAbsolute(repo.localPath) ? repo.localPath : undefined,
    localPathConfigured: Boolean(repo.localPath), credentialsRefConfigured: repo.credentialsRef !== 'unconfigured' };
  });
}
function publicProjectGroups(platform: PlatformConfig) {
  return platform.projectGroups.map(group => ({ projectKey: group.projectKey,
    repositories: publicRepositories(group.repositories), defaultRepoKey: group.defaultRepoKey,
    searchRootConfigured: Boolean(group.searchRoot) }));
}
export function readSettings(paths: SettingsPaths) {
  const { platform, schedules, revision } = load(paths);
  const creds = readCredentials();
  return { revision, restartRequired: true,
    groups: { projectGroups: publicProjectGroups(platform), schedules: schedules.tasks,
      agents: platform.agents, budget: platform.budget, policyRef: platform.policyRef,
      releasePipelines: platform.releasePipelines, port: platform.interaction?.port,
      review: platform.review ?? reviewConfig.parse({}),
      devopsCredentials: creds ? { authorization: '(已配置，留空保持不变)', cookie: '(已配置，留空保持不变)' }
        : { authorization: '', cookie: '' } },
    protected: { actorId: platform.interaction?.actorId, roles: platform.interaction?.roles,
      credentialFileConfigured: Boolean(platform.interaction?.credentialFile),
      devopsCredentialsConfigured: credentialsExist() } };
}

function writeAtomicBytes(path: string, bytes: string, expectedBytes: string): void {
  const target = resolve(path);
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Configuration target must be a regular file');
  if (readFileSync(target, 'utf8') !== expectedBytes) throw new Error('Configuration changed; reload before saving');
  const temporary = resolve(dirname(target), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: info.mode & 0o777 });
    if (readFileSync(target, 'utf8') !== expectedBytes) throw new Error('Configuration changed; reload before saving');
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}
function writeAtomic(path: string, value: unknown, expectedBytes: string): void {
  writeAtomicBytes(path, `${JSON.stringify(value, null, 2)}\n`, expectedBytes);
}
export function saveSettings(paths: SettingsPaths, group: SettingsGroup, expectedRevision: string, value: unknown) {
  const current = load(paths);
  if (current.revision !== expectedRevision) throw new Error('Configuration version changed; reload before saving');
  if (group === 'devopsCredentials') {
    const input = value as Record<string, unknown>;
    const existing = readCredentials();
    const authorization = typeof input.authorization === 'string' && !input.authorization.startsWith('(已配置')
      ? input.authorization : existing?.authorization;
    const cookie = typeof input.cookie === 'string' && !input.cookie.startsWith('(已配置')
      ? input.cookie : existing?.cookie;
    if (!authorization || !cookie) throw new Error('DevOps credentials require both authorization and cookie');
    writeCredentials({ authorization, cookie });
    return { revision: load(paths).revision, restartRequired: false };
  }
  const nextPlatform: Record<string, unknown> = { ...current.platformRaw };
  const nextSchedules: Record<string, unknown> = { ...current.schedules };
  const renames = new Map<string, string>();
  if (group === 'schedules') nextSchedules.tasks = value;
  else if (group === 'projectGroups') {
    if (!Array.isArray(value)) throw new Error('Project groups must be an array');
    const incomingKeys = new Set(value.map(item => item?.projectKey));
    nextPlatform.projectGroups = value.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid project group');
      const group = item as Record<string, unknown>;
      const { searchRootConfigured: _configured, ...fields } = group;
      void _configured;
      if (!Array.isArray(group.repositories)) throw new Error('Project repositories must be an array');
      const knownKeys = group.repositories.map((repo: Record<string, unknown>) => repo?.repoKey)
        .filter((key): key is string => typeof key === 'string' &&
          current.platform.repositories.some(repo => repo.repoKey === key));
      const previous = current.platform.projectGroups.find(existing => existing.projectKey === group.projectKey) ??
        current.platform.projectGroups.find(existing => !incomingKeys.has(existing.projectKey) &&
          knownKeys.length > 0 && knownKeys.every(key => existing.repoKeys.includes(key)));
      if (previous && previous.projectKey !== group.projectKey) {
        if (renames.has(previous.projectKey)) throw new Error(`Project group ${previous.projectKey} split is ambiguous`);
        renames.set(previous.projectKey, String(group.projectKey));
      }
      const repositories = group.repositories.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid repository');
        const repo = item as Record<string, unknown>;
        const old = current.platform.repositories.find(existing => existing.repoKey === repo.repoKey);
        if ('credentialsRef' in repo) throw new Error('Repository credential references are protected');
        const { localPathConfigured: _path, credentialsRefConfigured: _credential, ...visible } = repo;
        void _path; void _credential;
        return { ...visible, credentialsRef: old?.credentialsRef ?? 'unconfigured',
          localPath: repo.localPath === null ? undefined : repo.localPath ?? old?.localPath };
      });
      return { ...fields, repositories,
        searchRoot: group.searchRoot === null ? undefined : group.searchRoot ?? previous?.searchRoot };
    });
    if (renames.size) nextSchedules.tasks = current.schedules.tasks.map(task => ({ ...task,
      projectKey: renames.get(task.projectKey) ?? task.projectKey }));
  }
  else if (group === 'review') {
    if (value === null) delete nextPlatform.review;
    else nextPlatform.review = reviewConfig.parse(value);
  }
  else if (group === 'port') {
    if (!nextPlatform.interaction || typeof nextPlatform.interaction !== 'object') throw new Error('Interaction is not configured');
    nextPlatform.interaction = { ...nextPlatform.interaction, port: value };
  } else nextPlatform[group] = value;
  const platform = platformConfig.parse(nextPlatform);
  const schedules = scheduleConfig.parse(nextSchedules);
  validatePair(platform, schedules);
  if (group === 'schedules') writeAtomic(paths.schedules, schedules, current.scheduleBytes);
  else if (renames.size) {
    const nextPlatformBytes = `${JSON.stringify(nextPlatform, null, 2)}\n`;
    writeAtomicBytes(paths.platform, nextPlatformBytes, current.platformBytes);
    try { writeAtomic(paths.schedules, schedules, current.scheduleBytes); }
    catch (error) {
      try { writeAtomicBytes(paths.platform, current.platformBytes, nextPlatformBytes); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Could not restore project group configuration'); }
      throw error;
    }
  } else writeAtomic(paths.platform, nextPlatform, current.platformBytes);
  return { revision: load(paths).revision, restartRequired: true };
}
