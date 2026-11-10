import { z } from 'zod';
import { actorRef, evidenceRef, id, timestamp } from '../shared/model.js';
import { action, mandate } from '../agent/task/model.js';
import { routeCandidate } from '../agent/router/model.js';

export const question = z.object({ id, taskId: id, runId: id, prompt: id, options: z.array(id).optional(), evidenceRefs: z.array(evidenceRef), status: z.enum(['open', 'answered', 'dismissed']) });
const humanActor = actorRef.extend({ kind: z.literal('human') });
export const answer = z.object({ questionId: id, actor: humanActor, content: z.string(), idempotencyKey: id });
export const routeReviewRequest = z.object({ eventId: id, candidates: z.array(routeCandidate), reason: id });
export const routeReviewDecision = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('existing_task'), eventId: id, taskId: id, actor: humanActor, at: timestamp, idempotencyKey: id, reason: id }),
  z.object({ choice: z.literal('new_task'), eventId: id, repoKey: id, parentTaskId: id.optional(),
    actor: humanActor, at: timestamp, idempotencyKey: id, reason: id }),
  z.object({ choice: z.literal('ignored'), eventId: id, actor: humanActor, at: timestamp, idempotencyKey: id, reason: id }),
]);
export const approvalRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scope_change'), id, taskId: id, iteration: z.number().int().positive(),
    proposedMandate: mandate, sourceSha: id, policyVersion: id }),
  z.object({ kind: z.literal('action'), id, taskId: id, action, sourceSha: id, reviewRecordId: id.optional(),
    targetBranch: id.optional(), targetSha: id.optional(), changeRef: id.optional(), environment: id.optional(), releaseVersion: id.optional(), releaseTargetDigest: id.optional(), policyVersion: id })
    .superRefine((value, context) => { if (['open_pr', 'merge'].includes(value.action) && (!value.targetBranch || !value.targetSha || !value.reviewRecordId))
      context.addIssue({ code: 'custom', message: 'Code-host approval needs review, target branch and SHA' });
      if (value.action === 'merge' && !value.changeRef) context.addIssue({ code: 'custom', message: 'Merge approval needs change ref' });
      if ((value.action === 'release' || value.action === 'rollback') && (!value.environment || !value.releaseVersion || !value.releaseTargetDigest)) context.addIssue({ code: 'custom', message: 'Release approval needs environment, version and target digest' }); }),
]);
export const approvalDecision = z.object({ requestId: id, actor: humanActor, decision: z.enum(['approve', 'reject']), at: timestamp, idempotencyKey: id });
export const reopenTaskCommand = z.object({ taskId: id, relatedTaskId: id, evidenceRunId: id,
  evidenceRecordId: id, finding: z.enum(['original_defect_reproduced', 'prior_fix_caused_defect']),
  reviewedSha: z.string().regex(/^[a-f0-9]{40}$/), expectedIteration: z.number().int().positive(),
  expectedUpdatedAt: timestamp, idempotencyKey: id, reason: id, actor: humanActor, at: timestamp });
export const humanRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), value: question }), z.object({ kind: z.literal('approval'), value: approvalRequest }),
  z.object({ kind: z.literal('route_review'), value: routeReviewRequest }),
]);
export const humanResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), value: answer }), z.object({ kind: z.literal('approval_decision'), value: approvalDecision }),
  z.object({ kind: z.literal('route_decision'), value: routeReviewDecision }),
]);
export interface InteractionService {
  ask(value: z.infer<typeof question>): Promise<z.infer<typeof question>>;
  answer(value: z.infer<typeof answer>): Promise<void>;
  requestApproval(value: z.infer<typeof approvalRequest>): Promise<z.infer<typeof approvalRequest>>;
  decide(value: z.infer<typeof approvalDecision>): Promise<void>;
}
