import { z } from 'zod';
import { id } from '../shared/model.js';
import { action, mandate } from '../agent/task/model.js';

export const effectRequest = z.object({ taskId: id, action, repoKey: id, idempotencyKey: id,
  sourceSha: id.optional(), targetSha: id.optional(), environment: id.optional(), policyVersion: id });
export const effectDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('denied'), reason: id }),
  z.object({ kind: z.literal('needs_approval'), requestId: id }),
  z.object({ kind: z.literal('executed'), receiptRef: id }),
]);
export interface MandatePolicy { evaluate(request: z.infer<typeof effectRequest>, current: z.infer<typeof mandate>): 'allow' | 'deny' | 'needs_approval' }
export interface EffectGateway { execute(request: z.infer<typeof effectRequest>): Promise<z.infer<typeof effectDecision>> }
export const denyUnconfigured: EffectGateway = { async execute() { return { kind: 'denied', reason: 'No external effect executor is configured' }; } };
export function investigationMandate(sourceEventId: string, repoKey: string, goal: string, policyVersion: string, ruleRef: string): z.infer<typeof mandate> {
  return mandate.parse({ sourceEventId, repoKey, goal, policyVersion, allowedActions: ['investigate'], maxAutoRisk: 'low',
    authority: { kind: 'trusted_rule', ruleRef } });
}
