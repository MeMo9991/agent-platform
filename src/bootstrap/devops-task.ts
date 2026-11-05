import { z } from 'zod';
import { id } from '../shared/model.js';
import type { EventIngress } from '../event/model.js';
import { pollSource } from '../event/poll.js';
import { createDefectApiReaders } from '../event/sources/devops/client.js';
import { createDefectSource } from '../event/sources/devops/defects.js';
import type { TaskHandler } from './scheduler.js';

export const devopsDefectParameters = z.object({
  sourceId: id, businessProjectId: z.number().int().positive(), pageSize: z.number().int().positive().optional(),
  repoKey: id.optional(),
}).strict();

export function createDevopsDefectTask(ingress: EventIngress, authorizationHeaders: () => Promise<HeadersInit>,
  request: typeof fetch = fetch): TaskHandler {
  return async input => {
    const config = devopsDefectParameters.parse(input);
    const readers = createDefectApiReaders(config, authorizationHeaders, request);
    await pollSource(createDefectSource(config, readers.readPage, readers.readDetail), ingress);
  };
}
