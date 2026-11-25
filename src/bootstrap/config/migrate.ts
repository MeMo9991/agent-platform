import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { platformFields } from './config.js';
import { readConfigDocuments } from './documents.js';
import type { loadConfiguration } from './load.js';

export function previewConfigMigration(root: string, legacy: ReturnType<typeof loadConfiguration>) {
  const { platform, schedules, env } = legacy;
  const requiredEnvironment = new Set(platform.repositories.flatMap(repo =>
    /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(repo.credentialsRef)?.[1] ?? []));
  if (env.QODERCN_PERSONAL_ACCESS_TOKEN) requiredEnvironment.add('QODERCN_PERSONAL_ACCESS_TOKEN');

  function preview(document: unknown, ignored: string[] = []) {
    const yaml = stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 });
    readConfigDocuments({ local: resolve(root, 'config/local.yaml') }, yaml);
    return { yaml, ignored, requiredEnvironment: [...requiredEnvironment] };
  }

  if ('local' in legacy.paths) {
    if (!legacy.paths.local.endsWith('.json')) throw new Error('No JSON configuration was selected for migration');
    return preview(legacy.local);
  }
  const unresolved = platform.projectGroups.filter(group => group.verification === true);
  if (unresolved.length) throw new Error(
    `Choose verification.type before migrating these project groups: ${unresolved.map(group => group.projectKey).join(', ')}`);
  const ignored = Object.keys(legacy.platformRaw).filter(key => !Object.hasOwn(platformFields, key));

  const document = {
    platform: { ...platform,
      interaction: platform.interaction ?? false,
      repositories: platform.repositories.filter(repo => !('credentialGroupKey' in repo)),
      projectGroups: platform.projectGroups.map(group => ({ ...group,
        repoKeys: group.repositories.length ? undefined : group.repoKeys,
        repositories: group.repositories.map(({ credentialGroupKey: _, ...repo }) => repo),
      })),
    },
    schedules: schedules.tasks,
    instance: { runtimeRoot: legacy.runtimeRoot, database: legacy.database },
    capabilities: legacy.capabilities,
    tools: { javaHome: legacy.javaHome || undefined, mavenSettings: legacy.mavenSettings || undefined,
      devopsAuthProvider: legacy.authProvider },
    credentials: { devopsFile: env.DEVOPS_CREDENTIALS_PATH,
      codeHostFile: env.AGENT_PLATFORM_CODE_HOST_CREDENTIALS_PATH, qoderPatFile: env.AGENT_PLATFORM_QODER_PAT_PATH },
    maintenance: { workspaceRetentionDays: legacy.workspaceRetentionMs / 86_400_000,
      workspaceOrphanHours: legacy.workspaceOrphanGraceMs / 3_600_000 },
  };
  return preview(document, ignored);
}
