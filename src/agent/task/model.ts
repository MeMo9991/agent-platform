import { z } from 'zod';
import { actorRef, evidenceRef, id, timestamp } from '../../shared/model.js';

export const action = z.enum(['investigate', 'edit', 'open_pr', 'merge', 'release', 'rollback']);
export const mandate = z.object({ sourceEventId: id, repoKey: id, goal: id, allowedActions: z.array(action),
  maxAutoRisk: z.enum(['low', 'medium', 'high']), policyVersion: id,
  authority: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('trusted_rule'), ruleRef: id }),
    z.object({ kind: z.literal('human_approval'), approvalRef: id }),
  ]),
}).superRefine((value, context) => {
  if (value.authority.kind === 'trusted_rule' && (value.maxAutoRisk !== 'low' || value.allowedActions.some(item => item !== 'investigate')))
    context.addIssue({ code: 'custom', message: 'Trusted intake rule may only grant low-risk investigation' });
});
export type TaskMandate = z.infer<typeof mandate>;
export const taskState = z.enum(['new', 'triaged', 'queued', 'investigating', 'developing', 'verifying', 'reviewing',
  'ready_to_merge', 'merging', 'merged', 'release_pending', 'releasing', 'released', 'closed',
  'waiting_human', 'paused', 'blocked', 'failed', 'cancelled']);
export type TaskState = z.infer<typeof taskState>;
export const task = z.object({ id, originEventId: id.optional(), repoKey: id, title: id, scope: id, mandate,
  state: taskState, iteration: z.number().int().positive(), priority: z.number().int(), owner: id.optional(),
  baseRef: id.optional(), parentTaskId: id.optional(), createdAt: timestamp, updatedAt: timestamp })
  .refine(value => value.repoKey === value.mandate.repoKey, 'Task and Mandate must name the same repository');
export type Task = z.infer<typeof task>;
export const subscription = z.object({ taskId: id, sourceId: id, targetKind: z.enum(['thread', 'object']),
  targetKey: id, mode: z.enum(['handle', 'context']) });
export type Subscription = z.infer<typeof subscription>;
const recordBase = z.object({ id, taskId: id, runId: id.optional(), eventId: id.optional(), at: timestamp });
export const taskRecord = z.discriminatedUnion('kind', [
  recordBase.extend({ kind: z.literal('event_link'), eventId: id, mode: z.enum(['handle', 'context']), status: z.enum(['recorded', 'pending', 'delivered', 'handled', 'uncertain', 'handback']) }),
  recordBase.extend({ kind: z.literal('question'), prompt: id, status: z.enum(['open', 'answered', 'dismissed']) }),
  recordBase.extend({ kind: z.literal('agent_report'), runId: id, status: z.enum(['progress', 'succeeded', 'failed']), summary: id }),
  recordBase.extend({ kind: z.literal('content_review'), targetKind: z.enum(['question', 'result']),
    targetId: id, text: z.string().trim().min(1).max(8192), status: z.literal('published'),
    actor: actorRef.extend({ kind: z.literal('human') }), idempotencyKey: id }),
  recordBase.extend({ kind: z.literal('human_result'), actor: actorRef.extend({ kind: z.literal('human') }),
    summary: id, disposition: z.enum(['resume', 'cancel']), idempotencyKey: id,
    codeChange: z.enum(['none', 'committed']).optional(), commitSha: id.optional(),
    developmentRecordId: id.optional() }),
  recordBase.extend({ kind: z.literal('session_handoff'), runId: id, fromSessionId: id,
    toSessionId: id, summary: id }),
  recordBase.extend({ kind: z.literal('reopen'), relatedTaskId: id, evidenceRunId: id,
    evidenceRecordId: id, finding: z.enum(['original_defect_reproduced', 'prior_fix_caused_defect']),
    reviewedSha: id, previousIteration: z.number().int().positive(), nextIteration: z.number().int().positive(),
    previousState: taskState, previousUpdatedAt: timestamp, previousBaseSha: id.optional(), idempotencyKey: id,
    actor: actorRef.extend({ kind: z.literal('human') }), reason: id }),
  recordBase.extend({ kind: z.literal('reopen_transfer'), targetTaskId: id, reopeningRecordId: id,
    evidenceRunId: id }),
  recordBase.extend({ kind: z.literal('answer'), questionId: id, content: z.string(), idempotencyKey: id,
    status: z.enum(['pending', 'delivered', 'uncertain']), actor: actorRef }),
  recordBase.extend({ kind: z.literal('approval_request'), request: z.unknown(),
    status: z.enum(['open', 'approved', 'rejected', 'invalidated']), invalidatedByReopenId: id.optional() }),
  recordBase.extend({ kind: z.literal('development'), runId: id, baseSha: id, commitSha: id,
    diffRef: id, postCheckVerified: z.boolean(), postCheckError: id.optional() }),
  recordBase.extend({ kind: z.literal('check'), subjectSha: id, command: id, args: z.array(z.string()),
    timeoutMs: z.number().int().positive(), startedAt: timestamp, endedAt: timestamp,
    result: z.enum(['passed', 'failed', 'timeout', 'unavailable']), exitCode: z.number().int().nullable(),
    logRef: id, terminationConfirmed: z.boolean() }),
  recordBase.extend({ kind: z.literal('review'), subjectSha: id, verdict: z.enum(['pass', 'block']), findings: z.array(z.object({ file: id, severity: id, evidence: id, impact: id })) }),
  recordBase.extend({ kind: z.literal('approval'), requestId: id, action, subjectSha: id, policyVersion: id,
    idempotencyKey: id, actor: actorRef.extend({ kind: z.literal('human') }), decision: z.enum(['approve', 'reject']) }),
  recordBase.extend({ kind: z.literal('effect'), action, idempotencyKey: id, status: z.enum(['pending', 'done', 'uncertain', 'failed']), subjectSha: id.optional() }),
  recordBase.extend({ kind: z.literal('release'), environment: id, version: id, status: z.enum(['pending', 'succeeded', 'failed']) }),
  recordBase.extend({ kind: z.literal('state_change'), from: taskState, to: taskState, reason: id, actor: actorRef, evidenceRefs: z.array(evidenceRef).optional() }),
]);
export type TaskRecord = z.infer<typeof taskRecord>;
export interface TaskRepository { get(id: string): Task | undefined; save(value: Task): void }
