import { z } from 'zod';
import { id } from '../shared/model.js';
import { repositoryConfig, type CodeHost } from '../repository-ci/model.js';
import type { ReleasePipeline } from '../repository-ci/model.js';
import type { AgentRunner } from '../agent/worker/model.js';
import type { PollingSource, PushSource } from '../event/model.js';

export type RegisteredSource =
  | { mode: 'polling'; source: PollingSource }
  | { mode: 'push'; source: PushSource };

export const platformConfig = z.object({ repositories: z.array(repositoryConfig).refine(
  values => new Set(values.map(value => value.repoKey)).size === values.length, 'Duplicate repoKey'),
  sources: z.array(z.object({ id, kind: id, configRef: id, enabled: z.boolean() })),
  agents: z.array(z.object({ kind: id, enabled: z.boolean() })),
  releasePipelines: z.array(z.object({ repoKey: id, environment: id, configRef: id })).default([]),
  budget: z.object({ maxRunMs: z.number().int().positive() }), policyRef: id })
  .superRefine((value, context) => {
    if (new Set(value.sources.map(item => item.id)).size !== value.sources.length ||
        new Set(value.agents.map(item => item.kind)).size !== value.agents.length ||
        new Set(value.releasePipelines.map(item => `${item.repoKey}\0${item.environment}`)).size !== value.releasePipelines.length ||
        value.releasePipelines.some(item => !value.repositories.some(repo => repo.repoKey === item.repoKey)))
      context.addIssue({ code: 'custom', message: 'Duplicate or unknown adapter registration' });
  });
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
