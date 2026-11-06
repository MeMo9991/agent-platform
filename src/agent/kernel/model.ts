import { z } from 'zod';
import { id } from '../../shared/model.js';
import { agentEvent, developmentEvidence } from '../worker/model.js';
import { humanResponse } from '../../interaction/model.js';
import type { reopenTaskCommand } from '../../interaction/model.js';

export const kernelSignal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_event'), eventId: id }),
  z.object({ kind: z.literal('agent_event'), taskId: id, event: agentEvent }),
  z.object({ kind: z.literal('human_response'), taskId: id.optional(), response: humanResponse }),
  z.object({ kind: z.literal('effect_receipt'), taskId: id, recordId: id }),
  z.object({ kind: z.literal('recovery'), taskId: id, runId: id.optional(), effectRecordId: id.optional(),
    observation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unknown'), reason: id }),
      z.object({ kind: z.literal('finished'), sessionId: id, exitCode: z.number().int(),
        resultRef: id.optional(), development: developmentEvidence.optional() }),
    ]).optional() }),
]);
export type KernelSignal = z.infer<typeof kernelSignal>;
export interface KernelCoordinator {
  onSignal(signal: KernelSignal): Promise<void>;
  reopenTask(value: z.infer<typeof reopenTaskCommand>): { taskId: string; iteration: number };
  onQuestionProcessEnded(runId: string, sessionId: string): void;
  onWorkerFailure(runId: string, reason: string, kind: 'pause' | 'missing_skill',
    processTerminationUnconfirmed?: boolean): void;
}
