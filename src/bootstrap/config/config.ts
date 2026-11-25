import { z } from 'zod';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { id } from '../../shared/model.js';
import { repositoryConfig, type CodeHost } from '../../repository-ci/model.js';
import { groupVerification, groupVerifier } from '../../agent/worker/group-verifiers.js';
import { readCodeHostGroupToken, readCodeHostToken } from '../credentials/code-host-credentials.js';
import { reviewConfig } from '../../authorization/policy/config.js';
import type { ReleasePipeline } from '../../repository-ci/model.js';
import { agentModel, type AgentRunner } from '../../agent/worker/model.js';
import type { PollingSource, PushSource } from '../../event/model.js';

export type RegisteredSource =
  | { mode: 'polling'; source: PollingSource }
  | { mode: 'push'; source: PushSource };

export const projectGroup = z.object({ projectKey: id,
  repositories: z.array(repositoryConfig).default([]),
  repoKeys: z.array(id).optional(), // legacy configuration is accepted during migration
  searchRoot: id.refine(isAbsolute, 'Project search root must be absolute').optional(),
  defaultRepoKey: id.optional(), verification: z.union([z.boolean(), groupVerification]).default(false),
  functionalVerificationUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  }, 'Functional verification must use a local HTTP URL without credentials').optional() }).strict()
  .refine(value => !value.repoKeys || !value.repositories.length, 'repoKeys cannot accompany nested repositories')
  .transform(value => ({ ...value,
    repoKeys: value.repositories.length ? value.repositories.map(repo => repo.repoKey) : value.repoKeys ?? [] }))
  .superRefine((value, context) => {
    if (value.functionalVerificationUrl && !value.verification)
      context.addIssue({ code: 'custom', path: ['verification'],
        message: 'Functional verification requires project group verification' });
    if (typeof value.verification === 'object') {
      if (value.verification.type === 'maven' && value.verification.scope === 'group' && !value.searchRoot)
        context.addIssue({ code: 'custom', path: ['searchRoot'], message: 'Maven group verification requires searchRoot' });
      if (!value.repositories.length || value.repositories.some(repo => !repo.localPath))
        context.addIssue({ code: 'custom', path: ['repositories'],
          message: 'Group verification requires nested repositories with localPath' });
    }
    if (new Set(value.repoKeys).size !== value.repoKeys.length)
      context.addIssue({ code: 'custom', path: ['repoKeys'],
        message: `Project group ${value.projectKey} has duplicate repository keys` });
    if (value.defaultRepoKey && !value.searchRoot)
      context.addIssue({ code: 'custom', path: ['searchRoot'],
        message: `Project group ${value.projectKey} sets defaultRepoKey without searchRoot` });
  });
export const devopsSourceConfig = z.object({
  businessProjectId: z.number().int().positive(), pageSize: z.number().int().positive().optional(),
}).strict();
const sourceConfig = z.object({ id, kind: id, configRef: id, enabled: z.boolean(),
  projectKey: id.optional(), devops: devopsSourceConfig.optional() });
export const devopsDefectSource = sourceConfig.safeExtend({
  kind: z.literal('devops-defect'), projectKey: id, devops: devopsSourceConfig,
});
export const platformFields = { repositories: z.array(repositoryConfig).default([]),
  projectGroups: z.array(projectGroup).default([]), sources: z.array(sourceConfig).default([]),
  agents: z.array(z.object({ kind: id, enabled: z.boolean(), model: agentModel.optional() })),
  interaction: z.object({ actorId: id, roles: z.array(z.enum(['answer', 'route', 'approve', 'reopen', 'submit', 'command', 'configure'])),
    credentialFile: id, port: z.number().int().min(1).max(65535) }).optional(),
  review: reviewConfig.optional(),
  cache: z.object({ root: id.optional() }).optional(),
  releasePipelines: z.array(z.object({ repoKey: id, environment: id, configRef: id })).default([]),
  budget: z.object({ maxRunMs: z.number().int().positive(), maxConcurrentRuns: z.number().int().positive().default(2),
    perRepoConcurrentRuns: z.number().int().positive().default(2),
    perAgentConcurrentRuns: z.number().int().positive().default(2),
    reservedHumanResume: z.number().int().nonnegative().default(1) }).refine(
      value => value.reservedHumanResume < value.maxConcurrentRuns, 'Resume reservation must leave a normal slot'), policyRef: id };
export const platformConfig = z.object(platformFields)
  .superRefine((value, context) => {
    const repositories = [...value.repositories, ...value.projectGroups.flatMap(group => group.repositories)];
    const groups = new Map(value.projectGroups.map(group => [group.projectKey, group.repoKeys]));
    const devopsProjects = value.sources.filter(source => source.kind === 'devops-defect')
      .map(source => source.devops?.businessProjectId);
    if (new Set(repositories.map(repo => repo.repoKey)).size !== repositories.length ||
        groups.size !== value.projectGroups.length ||
        new Set(devopsProjects).size !== devopsProjects.length ||
        value.projectGroups.some(group => group.repoKeys.some(repoKey => !repositories.some(repo => repo.repoKey === repoKey)) ||
          (group.defaultRepoKey && !group.repoKeys.includes(group.defaultRepoKey))) ||
        value.sources.some(source => source.kind === 'devops-defect' &&
          (!source.projectKey || !source.devops || !groups.has(source.projectKey))) ||
        new Set(value.sources.map(item => item.id)).size !== value.sources.length ||
        new Set(value.agents.map(item => item.kind)).size !== value.agents.length ||
        new Set(value.releasePipelines.map(item => `${item.repoKey}\0${item.environment}`)).size !== value.releasePipelines.length ||
        value.releasePipelines.some(item => !repositories.some(repo => repo.repoKey === item.repoKey)))
      context.addIssue({ code: 'custom', message: 'Duplicate or unknown adapter registration' });
  }).transform(value => ({ ...value,
    projectGroups: value.projectGroups.map(group => ({ ...group,
      repositories: group.repositories.map(repo => ({ ...repo, credentialGroupKey: group.projectKey })) })),
    repositories: [...value.repositories, ...value.projectGroups.flatMap(group => group.repositories.map(repo =>
      ({ ...repo, credentialGroupKey: group.projectKey })))] }));
export type PlatformConfig = z.infer<typeof platformConfig>;
export function configuredGroupVerifier(group: PlatformConfig['projectGroups'][number]) {
  if (typeof group.verification !== 'object' || !group.repositories.length) return undefined;
  const verification = group.verification;
  const verifier = groupVerifier(verification);
  if (verifier.buildFile && !group.searchRoot) return undefined;
  try {
    if ((!verifier.buildFile || statSync(resolve(group.searchRoot!, verifier.buildFile)).isFile()) &&
        group.repositories.every(repo => repo.localPath && statSync(resolve(repo.localPath)).isDirectory() &&
        (verification.type !== 'maven' || verification.scope === 'group' ||
          statSync(resolve(repo.localPath, verification.buildFile)).isFile()))) return verifier;
  } catch { return undefined; }
  return undefined;
}
export function configuredLocalVerification(repo: PlatformConfig['repositories'][number],
  agentVerifyEnabled: boolean): boolean {
  return Boolean(repo.localPath && repo.localChecks.length &&
    (repo.verify?.mode === 'platform' || agentVerifyEnabled));
}
export function stage5PreflightRepositories(config: PlatformConfig,
  environment: NodeJS.ProcessEnv = process.env): PlatformConfig['repositories'] {
  return config.repositories.filter(repo => {
    const name = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(repo.credentialsRef)?.[1];
    return Boolean(('credentialGroupKey' in repo && typeof repo.credentialGroupKey === 'string'
      ? readCodeHostGroupToken(repo.credentialGroupKey) : undefined) ??
      readCodeHostToken(repo.repoKey) ?? (name && environment[name]));
  });
}
export function selectCodeHost(repoKey: string, config: PlatformConfig, hosts: Readonly<Record<string, CodeHost | undefined>>): CodeHost {
  const repo = config.repositories.find(item => item.repoKey === repoKey);
  if (!repo) throw new Error(`Unknown repository ${repoKey}`);
  const host = hosts[repoKey];
  if (!host || host.repoKey !== repoKey || host.provider !== repo.provider) throw new Error(`Code host for ${repoKey} is unavailable or mismatched`);
  return host;
}
export function selectSource(sourceId: string, config: PlatformConfig,
  sources: Readonly<Record<string, RegisteredSource | undefined>>): RegisteredSource {
  if (!config.sources.some(item => item.id === sourceId && item.enabled) || !sources[sourceId])
    throw new Error(`Source ${sourceId} is unavailable`);
  return sources[sourceId];
}
export function selectAgentRunner(agentKind: string, config: PlatformConfig,
  runners: Readonly<Record<string, AgentRunner | undefined>>, requiredCapabilities: readonly string[] = []): AgentRunner {
  const runner = runners[agentKind];
  if (!config.agents.some(item => item.kind === agentKind && item.enabled) || !runner ||
      requiredCapabilities.some(capability => runner.capabilities()[capability] !== 'supported'))
    throw new Error(`Agent ${agentKind} is unavailable or lacks required capability`);
  return runner;
}
export function selectReleasePipeline(repoKey: string, environment: string, config: PlatformConfig,
  pipelines: Readonly<Record<string, Readonly<Record<string, ReleasePipeline | undefined>> | undefined>>): ReleasePipeline {
  const pipeline = pipelines[repoKey]?.[environment];
  if (!config.releasePipelines.some(item => item.repoKey === repoKey && item.environment === environment) ||
      !pipeline || pipeline.repoKey !== repoKey || pipeline.environment !== environment)
    throw new Error(`Release pipeline for ${repoKey}/${environment} is unavailable or mismatched`);
  return pipeline;
}
