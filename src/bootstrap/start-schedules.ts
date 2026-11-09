import { readFileSync } from 'node:fs';
import { createEventIngress } from '../event/ingress.js';
import { defectMetadataFields } from '../event/sources/devops/defects.js';
import type { MetadataFields } from '../event/model.js';
import { SqliteStore } from '../storage/sqlite/store.js';
import { platformConfig } from './config.js';
import { createDevopsDefectTask, devopsDefectParameters } from './devops-task.js';
import { loadScheduleConfig, startSchedules } from './scheduler.js';
import { autoPrRuleRef } from '../authorization/auto-pr.js';

export function startConfiguredSchedules(paths: { platform: string; schedules: string; database: string },
  authorizationHeaders: () => Promise<HeadersInit>, onError: (taskId: string, error: unknown) => void,
  request: typeof fetch = fetch): { store: SqliteStore; stop: () => Promise<void> } {
  const platform = platformConfig.parse(JSON.parse(readFileSync(paths.platform, 'utf8')));
  const schedule = loadScheduleConfig(paths.schedules);
  const sourceIds = new Set<string>();
  for (const task of schedule.tasks.filter(task => task.kind === 'devops-defect-poll')) {
    const params = devopsDefectParameters.parse(task.parameters);
    if (sourceIds.has(params.sourceId)) throw new Error(`Duplicate scheduled scan for source ${params.sourceId}`);
    sourceIds.add(params.sourceId);
    const source = platform.sources.find(source => source.id === params.sourceId);
    if (!source || source.kind !== 'devops-defect' || source.configRef !== task.id || (task.enabled && !source.enabled))
      throw new Error(`Scheduled task ${task.id} has no matching enabled DevOps source`);
    if (params.repoKey && !platform.repositories.some(repo => repo.repoKey === params.repoKey))
      throw new Error(`Unknown repository ${params.repoKey} for scheduled task ${task.id}`);
  }
  const metadata: Record<string, readonly string[]> = Object.fromEntries(platform.sources.filter(source => source.kind === 'devops-defect')
    .map(source => [source.id, defectMetadataFields])) satisfies MetadataFields;
  for (const repo of platform.repositories) metadata[`manual:${repo.repoKey}`] = autoPrRuleRef(repo, platform.policyRef)
    ? ['contentDigest', 'autoPr'] : ['contentDigest'];
  const store = new SqliteStore(paths.database, metadata);
  try {
    store.transaction(() => {
      for (const source of platform.sources) store.registerSource(source.id, source.kind, source.configRef, source.enabled);
      for (const repo of platform.repositories) store.registerSource(`manual:${repo.repoKey}`, 'manual', repo.repoKey, true);
    });
    const ingress = createEventIngress(store, metadata);
    const stopTimers = startSchedules(schedule, {
      'devops-defect-poll': createDevopsDefectTask(ingress, authorizationHeaders, request),
    }, onError);
    let stopped = false;
    return { store, async stop() { if (stopped) return; stopped = true; await stopTimers(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
