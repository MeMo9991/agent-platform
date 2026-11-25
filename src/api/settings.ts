import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { stage5PreflightRepositories, type PlatformConfig } from '../bootstrap/config/config.js';
import { readConfigDocuments, type ConfigPaths } from '../bootstrap/config/documents.js';
import { devopsCredentials, readCredentials, writeCredentials } from '../bootstrap/credentials/devops-credentials.js';
import { readCodeHostGroupToken, readCodeHostToken, writeCodeHostGroupToken } from '../bootstrap/credentials/code-host-credentials.js';
import { readQoderPat, writeQoderPat } from '../bootstrap/credentials/qoder-credentials.js';

export const settingsGroup = z.enum(['projectGroupToken', 'qoderPat', 'devopsCredentials']);
export type SettingsGroup = z.infer<typeof settingsGroup>;
export type SettingsPaths = ConfigPaths;
export type SettingsSnapshot = Pick<ReturnType<typeof readConfigDocuments>, 'platform' | 'schedules' | 'revision'> & {
  capabilities?: { stage5Worker: boolean; qoderWrite: boolean; stage5Writes: boolean };
};
type SettingsContext = { active?: SettingsSnapshot; externalDevopsAuth?: boolean };

function publicRepositories(repositories: PlatformConfig['repositories']) {
  return repositories.map(repo => {
    const { credentialsRef: _protected, credentialGroupKey: _group, ...visible } = repo as typeof repo &
      { credentialGroupKey?: string };
    void _protected;
    return { ...visible,
    autoPr: repo.autoPr ?? { enabled: false, allowedPrefixes: [] },
    localPath: repo.localPath && !isAbsolute(repo.localPath) ? repo.localPath : undefined,
    localPathConfigured: Boolean(repo.localPath),
    credentialsRefConfigured: repo.credentialsRef !== 'unconfigured' || Boolean(readCodeHostToken(repo.repoKey)) };
  });
}
function publicProjectGroups(platform: PlatformConfig) {
  const configuredRepositories = new Set(stage5PreflightRepositories(platform).map(repo => repo.repoKey));
  return platform.projectGroups.map(group => ({ projectKey: group.projectKey,
    repositories: publicRepositories(group.repositories), defaultRepoKey: group.defaultRepoKey,
    verification: group.verification, functionalVerificationUrl: group.functionalVerificationUrl,
    searchRootConfigured: Boolean(group.searchRoot),
    tokenConfigured: Boolean(readCodeHostGroupToken(group.projectKey)) ||
      (group.repositories.length > 0 && group.repositories.every(repo => configuredRepositories.has(repo.repoKey))) }));
}
export function readSettings(paths: SettingsPaths, { active, externalDevopsAuth }: SettingsContext = {}) {
  let persisted: SettingsSnapshot | undefined;
  let configurationError: string | undefined;
  try { persisted = readConfigDocuments(paths); }
  catch (error) {
    if (!active) throw error;
    configurationError = (error as Error).message;
  }
  const { platform, schedules, revision, capabilities } = active ?? persisted!;
  let devopsCredentialsConfigured = false;
  let devopsCredentialError: string | undefined;
  if (!externalDevopsAuth) {
    try { devopsCredentialsConfigured = Boolean(readCredentials()); }
    catch { devopsCredentialError = 'Cannot read the local DevOps credentials'; }
  }
  return { revision, configurationSource: 'local' in paths ? 'local' : 'legacy',
    configurationFile: 'local' in paths ? (paths.local.endsWith('.json') ? 'config/local.json' : 'config/local.yaml') : undefined,
    pendingRestart: Boolean(active && persisted && active.revision !== persisted.revision), configurationError,
    groups: { projectGroups: publicProjectGroups(platform), schedules: schedules.tasks,
      agents: platform.agents, budget: platform.budget, policyRef: platform.policyRef,
      releasePipelines: platform.releasePipelines, review: platform.review ?? null,
      instance: { port: platform.interaction?.port, capabilities },
    },
    protected: { actorId: platform.interaction?.actorId, roles: platform.interaction?.roles,
      credentialFileConfigured: Boolean(platform.interaction?.credentialFile),
      devopsCredentialSource: externalDevopsAuth ? 'external' : 'local',
      devopsCredentialsConfigured, devopsCredentialError,
      qoderPatConfigured: Boolean(readQoderPat()) },
  };
}

export function saveSettings(paths: SettingsPaths, group: SettingsGroup, expectedRevision: string, value: unknown,
  { active, externalDevopsAuth }: SettingsContext = {}) {
  const { revision, platform } = active ?? readConfigDocuments(paths);
  if (revision !== expectedRevision) throw new Error('Configuration version changed; reload before saving');
  if (group === 'qoderPat') {
    const { token } = z.object({ token: z.string().trim() }).strict().parse(value);
    writeQoderPat(token);
    return { revision, restartRequired: false };
  }
  if (group === 'projectGroupToken') {
    const input = z.object({ projectKey: z.string().min(1), token: z.string().min(1).max(4096)
      .regex(/^[\x21-\x7e]+$/) }).strict().parse(value);
    const target = platform.projectGroups.find(item => item.projectKey === input.projectKey);
    if (!target) throw new Error('Project group is not configured');
    if (new Set(target.repositories.map(repo => repo.provider)).size > 1)
      throw new Error('Project group repositories must use one code host provider');
    writeCodeHostGroupToken(input.projectKey, input.token);
    return { revision, restartRequired: true };
  }
  if (externalDevopsAuth) throw new Error('DevOps credentials are managed by the external authorization provider');
  const input = devopsCredentials.partial().parse(value);
  if (!input.authorization && !input.cookie) throw new Error('Provide at least one DevOps credential');
  const existing = input.authorization && input.cookie ? undefined : readCredentials();
  const authorization = input.authorization ?? existing?.authorization;
  const cookie = input.cookie ?? existing?.cookie;
  if (!authorization || !cookie) throw new Error('DevOps credentials require both authorization and cookie');
  writeCredentials({ authorization, cookie });
  return { revision, restartRequired: false };
}
