import { readFileSync } from 'node:fs';
import { createEventIngress } from '../event/ingress.js';
import { defectMetadataFields } from '../event/sources/devops/defects.js';
import type { MetadataFields } from '../event/model.js';
import { SqliteStore } from '../storage/sqlite/store.js';
import { devopsDefectSource, platformConfig, type PlatformConfig } from './config.js';
import { createDevopsDefectTask, devopsDefectParameters } from './devops-task.js';
import { loadScheduleConfig, startSchedules, type ScheduleConfig } from './scheduler.js';

export function validateScheduledSources(platform: PlatformConfig, schedule: ScheduleConfig): void {
  const sourceIds = new Set<string>();
  for (const task of schedule.tasks.filter(task => task.kind === 'devops-defect-poll')) {
    const { sourceId } = devopsDefectParameters.parse(task.parameters);
    if (sourceIds.has(sourceId)) throw new Error(`Duplicate scheduled scan for source ${sourceId}`);
    sourceIds.add(sourceId);
    const source = platform.sources.find(item => item.id === sourceId);
    if (!source || source.kind !== 'devops-defect' || (task.enabled && !source.enabled))
      throw new Error(`Scheduled task ${task.id} has no matching enabled DevOps source`);
    devopsDefectSource.parse(source);
  }
}

export function startConfiguredSchedules(paths: { platform: string; schedules: string; database: string },
  authorizationHeaders: () => Promise<HeadersInit>, onError: (taskId: string, error: unknown) => void,
  request: typeof fetch = fetch): { store: SqliteStore; platform: PlatformConfig; stop: () => Promise<void> } {
  const configured = platformConfig.parse(JSON.parse(readFileSync(paths.platform, 'utf8')));
  const schedule = loadScheduleConfig(paths.schedules);
  validateScheduledSources(platform, schedule);
  const metadata: Record<string, readonly string[]> = Object.fromEntries(platform.sources.filter(source => source.kind === 'devops-defect')
    .map(source => [source.id, defectMetadataFields])) satisfies MetadataFields;
  for (const repo of platform.repositories) metadata[`manual:${repo.repoKey}`] = ['contentDigest'];
  const store = new SqliteStore(paths.database, metadata);
  try {
    store.transaction(() => {
      for (const source of platform.sources) store.registerSource(source.id, source.kind, source.configRef, source.enabled);
      for (const repo of platform.repositories) store.registerSource(`manual:${repo.repoKey}`, 'manual', repo.repoKey, true);
    });
    const ingress = createEventIngress(store, metadata);
    const stopTimers = startSchedules(schedule, {
      'devops-defect-poll': createDevopsDefectTask(platform, ingress, authorizationHeaders, request),
    }, onError);
    let stopped = false;
    return { store, platform, async stop() { if (stopped) return; stopped = true; await stopTimers(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
