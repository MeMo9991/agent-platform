import { z } from 'zod';
import { id, timestamp } from '../../shared/model.js';
import { mandate } from '../task/model.js';
import { loadedSkill, skillRef } from '../../skills/model.js';

export const runStage = z.enum(['investigate', 'develop', 'verify', 'review', 'release_prepare']);
export const runStatus = z.enum(['queued', 'running', 'waiting_human', 'paused', 'succeeded', 'failed', 'cancelled']);
export const agentUsage = z.discriminatedUnion('kind', [z.object({ kind: z.literal('unknown') }), z.object({ kind: z.literal('actual'), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() })]);
export const run = z.object({ id, taskId: id, iteration: z.number().int().positive(), stage: runStage, status: runStatus,
  requestKey: id.optional(), priority: z.number().int(), attempt: z.number().int().nonnegative(), leaseUntil: timestamp.optional(),
  agentKind: id.optional(), model: id.optional(), sessionId: id.optional(), workspaceRef: id.optional(), skillRef: skillRef.optional(),
  commitSha: id.optional(), usage: agentUsage.optional(), resultRef: id.optional(), createdAt: timestamp, endedAt: timestamp.optional() })
  .refine(value => !value.skillRef || value.skillRef.stage === value.stage, 'Run and SkillRef stages must match');
export type Run = z.infer<typeof run>;
export const sessionRef = z.object({ agentKind: id, sessionId: id });
export const workspaceRef = z.object({ repoKey: id, path: id, baseSha: id });
export const agentInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), runId: id, prompt: id, sourceEventIds: z.array(id) }),
  z.object({ kind: z.literal('source_followup'), eventId: id, content: z.string() }),
  z.object({ kind: z.literal('human_answer'), questionId: id, content: z.string(), idempotencyKey: id }),
]);
export const agentEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('progress'), runId: id, text: z.string(), at: timestamp }),
  z.object({ kind: z.literal('question'), runId: id, questionId: id, prompt: id }),
  z.object({ kind: z.literal('input_handled'), runId: id, eventId: id }),
  z.object({ kind: z.literal('handback'), runId: id, eventId: id, reason: id }),
  z.object({ kind: z.literal('result'), runId: id, status: z.enum(['succeeded', 'failed']), exitCode: z.number().int().nullable(), resultRef: id.optional() }),
  z.object({ kind: z.literal('usage'), runId: id, usage: agentUsage }),
]);
export const agentSnapshot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running'), runId: id }),
  z.object({ kind: z.literal('finished'), runId: id, exitCode: z.number().int(), resultRef: id.optional() }),
  z.object({ kind: z.literal('unknown'), runId: id }),
]);
export const runRequest = z.object({ taskId: id, runId: id, stage: runStage, mandate, repoKey: id,
  workspace: workspaceRef, input: agentInput, skill: loadedSkill, timeoutMs: z.number().int().positive() });
export type AgentInput = z.infer<typeof agentInput>;
export type AgentEvent = z.infer<typeof agentEvent>;
export interface AgentRunner {
  capabilities(): Record<string, 'supported' | 'unsupported' | 'unverified'>;
  start(request: z.infer<typeof runRequest>): Promise<{ sessionId: string }>;
  resume(request: z.infer<typeof runRequest>): Promise<{ sessionId: string } | { kind: 'unsupported' }>;
  send(sessionId: string, input: AgentInput): Promise<{ kind: 'accepted' | 'unsupported' }>;
  read(sessionId: string): Promise<z.infer<typeof agentSnapshot>>;
  cancel(sessionId: string): Promise<{ kind: 'accepted' | 'unsupported' }>;
}
export interface RunRepository { get(id: string): Run | undefined; save(value: Run): void }
export interface RunScheduler { claim(workerId: string): Promise<Run | undefined> }
export interface WorkspaceManager { prepare(run: Run): Promise<z.infer<typeof workspaceRef>> }
