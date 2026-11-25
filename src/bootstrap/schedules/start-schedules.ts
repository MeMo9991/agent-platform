import { createEventIngress } from '../../event/ingress.js';
import { defectMetadataFields } from '../../event/sources/devops/defects.js';
import type { MetadataFields } from '../../event/model.js';
import { SqliteStore } from '../../storage/sqlite/store.js';
import type { PlatformConfig } from '../config/config.js';
import { readConfigDocuments, validateConfiguredDocuments, type LegacyConfigPaths } from '../config/documents.js';
import { createDevopsDefectTask } from './devops-task.js';
import { createGithubPrTask, githubPrMetadataFields } from './github-pr-task.js';
import { startSchedules, type ScheduleConfig } from './scheduler.js';

export function withScheduledSources(platform: PlatformConfig, schedule: ScheduleConfig): PlatformConfig {
  validateConfiguredDocuments(platform, schedule);
  return { ...platform, sources: [...platform.sources, ...schedule.tasks.map(task => ({
    id: task.id, kind: task.kind === 'devops-defect-poll' ? 'devops-defect' : 'github-pr',
    configRef: task.id, enabled: task.enabled, projectKey: task.projectKey,
    ...(task.kind === 'devops-defect-poll' ? { devops: {
      businessProjectId: task.businessProjectId, pageSize: task.pageSize } } : {}),
  }))] };
}

export function startConfiguredSchedules(paths: LegacyConfigPaths & { database: string },
  authorizationHeaders: () => Promise<HeadersInit>, onError: (taskId: string, error: unknown) => void,
  request: typeof fetch = fetch): { store: SqliteStore; platform: PlatformConfig; stop: () => Promise<void> } {
  const { platform, schedules } = readConfigDocuments(paths);
  const runtime = createScheduledRuntime(paths.database, platform, schedules, authorizationHeaders, onError, request);
  try { runtime.start(); return runtime; }
  catch (error) { void runtime.stop(); throw error; }
}

export function createScheduledRuntime(database: string, configured: PlatformConfig, schedule: ScheduleConfig,
  authorizationHeaders: () => Promise<HeadersInit>, onError: (taskId: string, error: unknown) => void,
  request: typeof fetch = fetch) {
  const platform = withScheduledSources(configured, schedule);
  const metadata: Record<string, readonly string[]> = Object.fromEntries(platform.sources.map(source =>
    [source.id, source.kind === 'devops-defect' ? defectMetadataFields : githubPrMetadataFields])) satisfies MetadataFields;
  for (const repo of platform.repositories) metadata[`manual:${repo.repoKey}`] = ['contentDigest'];
  const store = new SqliteStore(database, metadata);
  try {
    store.transaction(() => {
      for (const source of platform.sources) store.registerSource(source.id, source.kind, source.configRef, source.enabled);
      for (const repo of platform.repositories) store.registerSource(`manual:${repo.repoKey}`, 'manual', repo.repoKey, true);
    });
    const ingress = createEventIngress(store, metadata);
    let stopTimers: (() => Promise<void>) | undefined;
    let stopped = false;
    return { store, platform,
      start() {
        if (stopTimers || stopped) throw new Error('Scheduled runtime already started or stopped');
        stopTimers = startSchedules(schedule, {
          'devops-defect-poll': createDevopsDefectTask(platform, ingress, authorizationHeaders, request),
          'github-pr-poll': createGithubPrTask(platform, ingress, request),
        }, onError);
      },
      async stop() { if (stopped) return; stopped = true; try { await stopTimers?.(); } finally { store.close(); } },
    };

  } catch (error) { store.close(); throw error; }
}
