import { z } from 'zod';
import { id } from '../../shared/model.js';
import { agentEvent } from '../worker/model.js';
import { humanResponse } from '../../interaction/model.js';

export const kernelSignal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_event'), eventId: id }),
  z.object({ kind: z.literal('agent_event'), taskId: id, event: agentEvent }),
  z.object({ kind: z.literal('human_response'), taskId: id, response: humanResponse }),
  z.object({ kind: z.literal('effect_receipt'), taskId: id, recordId: id }),
  z.object({ kind: z.literal('recovery'), taskId: id, runId: id.optional(), effectRecordId: id.optional() }),
]);
export type KernelSignal = z.infer<typeof kernelSignal>;
export interface KernelCoordinator { onSignal(signal: KernelSignal): Promise<void> }
