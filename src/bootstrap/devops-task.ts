import type { EventIngress } from '../event/model.js';
import { pollSource } from '../event/poll.js';
import { createDefectApiReaders } from '../event/sources/devops/client.js';
import { createDefectSource } from '../event/sources/devops/defects.js';
import type { TaskHandler } from './scheduler.js';
import type { PlatformConfig } from './config.js';
import { createRepositorySelector } from './repository-selection.js';

export function createDevopsDefectTask(platform: PlatformConfig, ingress: EventIngress,
  authorizationHeaders: () => Promise<HeadersInit>,
  request: typeof fetch = fetch): TaskHandler {
  const selectors = Object.fromEntries(platform.projectGroups.map(group =>
    [group.projectKey, createRepositorySelector(group, platform.repositories)]));
  return async task => {
    if (task.kind !== 'devops-defect-poll') throw new Error('Expected DevOps defect scan');
    const config = { sourceId: task.id, businessProjectId: task.businessProjectId, pageSize: task.pageSize };
    const readers = createDefectApiReaders(config, authorizationHeaders, request);
    await pollSource(createDefectSource(config, readers.readPage, readers.readDetail, selectors[task.projectKey]), ingress);
  };
}
