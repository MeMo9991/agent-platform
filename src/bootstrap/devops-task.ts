import type { EventIngress } from '../event/model.js';
import { pollSource } from '../event/poll.js';
import { createDefectApiReaders } from '../event/sources/devops/client.js';
import { createDefectSource } from '../event/sources/devops/defects.js';
import type { TaskHandler } from './scheduler.js';
import { devopsDefectSource, type PlatformConfig } from './config.js';
import { createRepositorySelector } from './repository-selection.js';

export const devopsDefectParameters = z.object({ sourceId: id }).strict();

export function createDevopsDefectTask(platform: PlatformConfig, ingress: EventIngress,
  authorizationHeaders: () => Promise<HeadersInit>,
  request: typeof fetch = fetch): TaskHandler {
  const selectors = Object.fromEntries(platform.sources.filter(source => source.kind === 'devops-defect')
    .map(source => [source.id, createRepositorySelector(
      platform.projectGroups.find(group => group.projectKey === source.projectKey)!, platform.repositories)]));
  return async input => {
    const { sourceId } = devopsDefectParameters.parse(input);
    const source = devopsDefectSource.parse(platform.sources.find(item => item.id === sourceId));
    const config = { sourceId, ...source.devops };
    const readers = createDefectApiReaders(config, authorizationHeaders, request);
    await pollSource(createDefectSource(config, readers.readPage, readers.readDetail, selectors[sourceId]), ingress);
  };
}
