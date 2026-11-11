import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { id } from '../shared/model.js';
import { repositoryConfig, type CodeHost } from '../repository-ci/model.js';
import type { ReleasePipeline } from '../repository-ci/model.js';
import type { AgentRunner } from '../agent/worker/model.js';
import type { PollingSource, PushSource } from '../event/model.js';

export type RegisteredSource =
  | { mode: 'polling'; source: PollingSource }
  | { mode: 'push'; source: PushSource };

export const projectGroup = z.object({ projectKey: id, repoKeys: z.array(id),
  searchRoot: id.refine(isAbsolute, 'Project search root must be absolute').optional(),
  defaultRepoKey: id.optional() }).strict().refine(
  value => new Set(value.repoKeys).size === value.repoKeys.length &&
    (!value.defaultRepoKey || value.searchRoot), 'Duplicate project repository or missing search root');
export const devopsSourceConfig = z.object({
  businessProjectId: z.number().int().positive(), pageSize: z.number().int().positive().optional(),
}).strict();
const sourceConfig = z.object({ id, kind: id, configRef: id, enabled: z.boolean(),
  projectKey: id.optional(), devops: devopsSourceConfig.optional() });
export const devopsDefectSource = sourceConfig.safeExtend({
  kind: z.literal('devops-defect'), projectKey: id, devops: devopsSourceConfig,
});
export const platformConfig = z.object({ repositories: z.array(repositoryConfig).refine(
  values => new Set(values.map(value => value.repoKey)).size === values.length, 'Duplicate repoKey'),
  projectGroups: z.array(projectGroup).default([]), sources: z.array(sourceConfig),
  agents: z.array(z.object({ kind: id, enabled: z.boolean() })),
  interaction: z.object({ actorId: id, roles: z.array(z.enum(['answer', 'route', 'approve', 'reopen', 'submit', 'command', 'configure'])),
    credentialFile: id, port: z.number().int().min(1).max(65535) }).optional(),
  releasePipelines: z.array(z.object({ repoKey: id, environment: id, configRef: id })).default([]),
  budget: z.object({ maxRunMs: z.number().int().positive(), maxConcurrentRuns: z.number().int().positive().default(2),
    perRepoConcurrentRuns: z.number().int().positive().default(2),
    perAgentConcurrentRuns: z.number().int().positive().default(2),
    reservedHumanResume: z.number().int().nonnegative().default(1) }).refine(
      value => value.reservedHumanResume < value.maxConcurrentRuns, 'Resume reservation must leave a normal slot'), policyRef: id })
  .superRefine((value, context) => {
    const groups = new Map(value.projectGroups.map(group => [group.projectKey, group.repoKeys]));
    const devopsProjects = value.sources.filter(source => source.kind === 'devops-defect')
      .map(source => source.devops?.businessProjectId);
    if (groups.size !== value.projectGroups.length ||
        new Set(devopsProjects).size !== devopsProjects.length ||
        value.projectGroups.some(group => group.repoKeys.some(repoKey => !value.repositories.some(repo => repo.repoKey === repoKey)) ||
          (group.defaultRepoKey && !group.repoKeys.includes(group.defaultRepoKey))) ||
        value.sources.some(source => source.kind === 'devops-defect' &&
          (!source.projectKey || !source.devops || !groups.has(source.projectKey))) ||
        new Set(value.sources.map(item => item.id)).size !== value.sources.length ||
        new Set(value.agents.map(item => item.kind)).size !== value.agents.length ||
        new Set(value.releasePipelines.map(item => `${item.repoKey}\0${item.environment}`)).size !== value.releasePipelines.length ||
        value.releasePipelines.some(item => !repositories.some(repo => repo.repoKey === item.repoKey)))
      context.addIssue({ code: 'custom', message: 'Duplicate or unknown adapter registration' });
  }).transform(value => ({ ...value,
    repositories: [...value.repositories, ...value.projectGroups.flatMap(group => group.repositories)] }));
export type PlatformConfig = z.infer<typeof platformConfig>;
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
