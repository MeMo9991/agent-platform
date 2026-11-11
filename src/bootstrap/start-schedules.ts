import { readFileSync } from 'node:fs';
import { createEventIngress } from '../event/ingress.js';
import { defectMetadataFields } from '../event/sources/devops/defects.js';
import type { MetadataFields } from '../event/model.js';
import { SqliteStore } from '../storage/sqlite/store.js';
import { platformConfig, type PlatformConfig } from './config.js';
import { createDevopsDefectTask } from './devops-task.js';
import { createGithubPrTask, githubPrMetadataFields } from './github-pr-task.js';
import { loadScheduleConfig, startSchedules, type ScheduleConfig } from './scheduler.js';

export function validateScheduledSources(platform: PlatformConfig, schedule: ScheduleConfig): void {
  const scans = new Set<string>();
  const sourceIds = new Set(platform.sources.map(source => source.id));
  const devopsProjects = new Set<number>();
  for (const task of schedule.tasks) {
    if (sourceIds.has(task.id) || task.id.startsWith('manual:'))
      throw new Error(`Duplicate or reserved event source ID ${task.id}`);
    sourceIds.add(task.id);
    const group = platform.projectGroups.find(item => item.projectKey === task.projectKey);
    if (!group) throw new Error(`Scheduled task ${task.id} has no matching project group`);
    const scan = `${task.kind}:${task.projectKey}`;
    if (scans.has(scan)) throw new Error(`Duplicate scheduled scan for project group ${task.projectKey}`);
    scans.add(scan);
    if (task.kind === 'devops-defect-poll') {
      if (devopsProjects.has(task.businessProjectId)) throw new Error('Duplicate DevOps businessProjectId');
      devopsProjects.add(task.businessProjectId);
    } else if (!group.repositories.length || group.repositories.some(repo => repo.provider !== 'github'))
      throw new Error(`GitHub PR scan requires GitHub repositories in ${task.projectKey}`);
  }
}

export function withScheduledSources(platform: PlatformConfig, schedule: ScheduleConfig): PlatformConfig {
  validateScheduledSources(platform, schedule);
  return { ...platform, sources: [...platform.sources, ...schedule.tasks.map(task => ({
    id: task.id, kind: task.kind === 'devops-defect-poll' ? 'devops-defect' : 'github-pr',
    configRef: task.id, enabled: task.enabled, projectKey: task.projectKey,
    ...(task.kind === 'devops-defect-poll' ? { devops: {
      businessProjectId: task.businessProjectId, pageSize: task.pageSize } } : {}),
  }))] };
}

export function startConfiguredSchedules(paths: { platform: string; schedules: string; database: string },
  authorizationHeaders: () => Promise<HeadersInit>, onError: (taskId: string, error: unknown) => void,
  request: typeof fetch = fetch): { store: SqliteStore; platform: PlatformConfig; stop: () => Promise<void> } {
  const configured = platformConfig.parse(JSON.parse(readFileSync(paths.platform, 'utf8')));
  const schedule = loadScheduleConfig(paths.schedules);
  const platform = withScheduledSources(configured, schedule);
  const metadata: Record<string, readonly string[]> = Object.fromEntries(platform.sources.map(source =>
    [source.id, source.kind === 'devops-defect' ? defectMetadataFields : githubPrMetadataFields])) satisfies MetadataFields;
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
      'github-pr-poll': createGithubPrTask(platform, ingress, request),
    }, onError);
    let stopped = false;
    return { store, platform, async stop() { if (stopped) return; stopped = true; await stopTimers(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
