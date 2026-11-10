import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { platformConfig, type PlatformConfig } from '../bootstrap/config.js';
import { devopsDefectParameters } from '../bootstrap/devops-task.js';
import { scheduleConfig, type ScheduleConfig } from '../bootstrap/scheduler.js';
import { devopsCredentials, readCredentials, writeCredentials, credentialsExist } from '../bootstrap/devops-credentials.js';

export const settingsGroup = z.enum(['repositories', 'sources', 'schedules', 'agents', 'budget', 'policyRef', 'releasePipelines', 'port', 'devopsCredentials']);
export type SettingsGroup = z.infer<typeof settingsGroup>;
export type SettingsPaths = { platform: string; schedules: string };

type Loaded = { platform: PlatformConfig; schedules: ScheduleConfig; revision: string; platformBytes: string; scheduleBytes: string };
function load(paths: SettingsPaths): Loaded {
  const platformBytes = readFileSync(paths.platform, 'utf8');
  const scheduleBytes = readFileSync(paths.schedules, 'utf8');
  return { platform: platformConfig.parse(JSON.parse(platformBytes)),
    schedules: scheduleConfig.parse(JSON.parse(scheduleBytes)),
    revision: createHash('sha256').update(platformBytes).update('\0').update(scheduleBytes).digest('hex'),
    platformBytes, scheduleBytes };
}
function validatePair(platform: PlatformConfig, schedules: ScheduleConfig): void {
  const sourceIds = new Set<string>();
  for (const task of schedules.tasks) {
    if (task.kind !== 'devops-defect-poll') {
      if (task.enabled) throw new Error(`No handler for scheduled task ${task.id}`);
      continue;
    }
    const params = devopsDefectParameters.parse(task.parameters);
    if (sourceIds.has(params.sourceId)) throw new Error(`Duplicate scheduled scan for source ${params.sourceId}`);
    sourceIds.add(params.sourceId);
    const source = platform.sources.find(item => item.id === params.sourceId);
    if (!source || source.kind !== 'devops-defect' || source.configRef !== task.id || (task.enabled && !source.enabled))
      throw new Error(`Scheduled task ${task.id} has no matching enabled source`);
    if (params.repoKey && !platform.repositories.some(repo => repo.repoKey === params.repoKey))
      throw new Error(`Unknown repository ${params.repoKey} for scheduled task ${task.id}`);
  }
  if (!platform.agents.some(agent => agent.kind === 'qoder') ||
      platform.agents.some(agent => agent.enabled && agent.kind !== 'qoder'))
    throw new Error('Only Qoder is available in this stage');
}
function publicRepositories(platform: PlatformConfig) {
  return platform.repositories.map(repo => {
    const { credentialsRef: _protected, ...visible } = repo;
    void _protected;
    return { ...visible,
    localPath: repo.localPath && !isAbsolute(repo.localPath) ? repo.localPath : undefined,
    localPathConfigured: Boolean(repo.localPath), credentialsRefConfigured: Boolean(repo.credentialsRef) };
  });
}
export function readSettings(paths: SettingsPaths) {
  const { platform, schedules, revision } = load(paths);
  const creds = readCredentials();
  return { revision, restartRequired: true,
    groups: { repositories: publicRepositories(platform), sources: platform.sources, schedules: schedules.tasks,
      agents: platform.agents, budget: platform.budget, policyRef: platform.policyRef,
      releasePipelines: platform.releasePipelines, port: platform.interaction?.port,
      devopsCredentials: creds ? { authorization: '(已配置，留空保持不变)', cookie: '(已配置，留空保持不变)' }
        : { authorization: '', cookie: '' } },
    protected: { actorId: platform.interaction?.actorId, roles: platform.interaction?.roles,
      credentialFileConfigured: Boolean(platform.interaction?.credentialFile),
      devopsCredentialsConfigured: credentialsExist() } };
}

function writeAtomic(path: string, value: unknown, expectedBytes: string): void {
  const target = resolve(path);
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Configuration target must be a regular file');
  if (readFileSync(target, 'utf8') !== expectedBytes) throw new Error('Configuration changed; reload before saving');
  const temporary = resolve(dirname(target), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: info.mode & 0o777 });
    if (readFileSync(target, 'utf8') !== expectedBytes) throw new Error('Configuration changed; reload before saving');
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
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
  const nextPlatform: Record<string, unknown> = { ...current.platform };
  const nextSchedules: Record<string, unknown> = { ...current.schedules };
  if (group === 'schedules') nextSchedules.tasks = value;
  else if (group === 'repositories') {
    if (!Array.isArray(value)) throw new Error('Repositories must be an array');
    nextPlatform.repositories = value.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid repository');
      const repo = item as Record<string, unknown>;
      const previous = current.platform.repositories.find(existing => existing.repoKey === repo.repoKey);
      if ('credentialsRef' in repo) throw new Error('Repository credential references are protected');
      const { localPathConfigured: _pathConfigured, credentialsRefConfigured: _credentialConfigured, ...fields } = repo;
      void _pathConfigured; void _credentialConfigured;
      return { ...fields, credentialsRef: previous?.credentialsRef ?? 'unconfigured',
        localPath: repo.localPath === null ? undefined : repo.localPath ?? previous?.localPath };
    });
  } else if (group === 'port') {
    if (!nextPlatform.interaction || typeof nextPlatform.interaction !== 'object') throw new Error('Interaction is not configured');
    nextPlatform.interaction = { ...nextPlatform.interaction, port: value };
  } else nextPlatform[group] = value;
  const platform = platformConfig.parse(nextPlatform);
  const schedules = scheduleConfig.parse(nextSchedules);
  validatePair(platform, schedules);
  if (group === 'schedules') writeAtomic(paths.schedules, schedules, current.scheduleBytes);
  else writeAtomic(paths.platform, platform, current.platformBytes);
  return { revision: load(paths).revision, restartRequired: true };
}
