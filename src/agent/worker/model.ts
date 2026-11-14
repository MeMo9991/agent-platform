import { z } from 'zod';
import { id, timestamp } from '../../shared/model.js';
import { mandate } from '../task/model.js';
import { loadedSkill, skillRef } from '../../skills/model.js';

export const runStage = z.enum(['investigate', 'develop', 'verify', 'review', 'release_prepare']);
export const runStatus = z.enum(['queued', 'running', 'waiting_human', 'paused', 'succeeded', 'failed', 'cancelled', 'completed']);
export const agentUsage = z.discriminatedUnion('kind', [z.object({ kind: z.literal('unknown') }), z.object({ kind: z.literal('actual'), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() })]);
export const executionAttestation = z.object({ verified: z.literal(true), runId: id,
  repoKey: id, workspacePath: id, mode: z.enum(['read', 'write']),
  adapterVersion: id, configDigest: id });
export const run = z.object({ id, taskId: id, iteration: z.number().int().positive(), stage: runStage, status: runStatus,
  requestKey: id.optional(), priority: z.number().int(), attempt: z.number().int().nonnegative(), leaseUntil: timestamp.optional(),
  queueClass: z.enum(['normal', 'human_resume']).optional(), workerId: id.optional(),
  agentKind: id.optional(), model: id.optional(), sessionId: id.optional(), workspaceRef: id.optional(), skillRef: skillRef.optional(),
  commitSha: id.optional(), execution: executionAttestation.optional(), checkWorkspaceRef: id.optional(), cacheKey: id.optional(),
  processTerminationUnconfirmed: z.boolean().optional(),
  questionTerminationVerified: z.boolean().optional(),
  usage: agentUsage.optional(), resultRef: id.optional(), createdAt: timestamp,
  startedAt: timestamp.optional(), endedAt: timestamp.optional() })
  .refine(value => !value.skillRef || value.skillRef.stage === value.stage, 'Run and SkillRef stages must match')
  .refine(value => !value.execution || value.execution.runId === value.id, 'Run and isolation proof must match');
export type Run = z.infer<typeof run>;
export const sessionRef = z.object({ agentKind: id, sessionId: id });
export const workspaceRef = z.object({ repoKey: id, path: id, baseSha: id });
export const agentInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), runId: id, prompt: id, sourceEventIds: z.array(id) }),
  z.object({ kind: z.literal('source_followup'), eventId: id, content: z.string() }),
  z.object({ kind: z.literal('human_answer'), questionId: id, content: z.string(), idempotencyKey: id }),
]);
export const developmentEvidence = z.object({ baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/), diffRef: id, changedPaths: z.array(id).optional(),
  postCheckVerified: z.boolean(), postCheckError: id.optional(),
  checks: z.array(z.object({ command: id, args: z.array(z.string()), timeoutMs: z.number().int().positive(),
    startedAt: timestamp, endedAt: timestamp, result: z.enum(['passed', 'failed', 'timeout', 'unavailable']),
    exitCode: z.number().int().nullable(), logRef: id, terminationConfirmed: z.boolean() })) });
export const verificationEvidence = z.object({ subjectSha: z.string().regex(/^[a-f0-9]{40}$/),
  postCheckVerified: z.boolean(), postCheckError: id.optional(), checks: developmentEvidence.shape.checks,
  cacheKey: id.optional() });
export const reviewEvidence = z.object({ subjectSha: z.string().regex(/^[a-f0-9]{40}$/),
  verdict: z.enum(['pass', 'block']), findings: z.array(z.object({ file: id, line: z.number().int().positive().optional(),
    severity: z.enum(['low', 'medium', 'high', 'unknown']), evidence: id, impact: id,
    action: id, verificationMethod: id })) });
export const agentEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('progress'), runId: id, text: z.string(), at: timestamp }),
  z.object({ kind: z.literal('question'), runId: id, questionId: id, prompt: id }),
  z.object({ kind: z.literal('input_handled'), runId: id, eventId: id }),
  z.object({ kind: z.literal('handback'), runId: id, eventId: id, reason: id }),
  z.object({ kind: z.literal('result'), runId: id, status: z.enum(['succeeded', 'failed']), exitCode: z.number().int().nullable(),
    resultRef: id.optional(), error: z.string().max(2048).optional(),
    development: developmentEvidence.optional(), verification: verificationEvidence.optional(),
    review: reviewEvidence.optional() }),
  z.object({ kind: z.literal('usage'), runId: id, usage: agentUsage }),
]);
export const agentSnapshot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running'), runId: id }),
  z.object({ kind: z.literal('finished'), runId: id, exitCode: z.number().int(), resultRef: id.optional(),
    error: z.string().max(2048).optional(),
    development: developmentEvidence.optional(), verification: verificationEvidence.optional(), review: reviewEvidence.optional() }),
  z.object({ kind: z.literal('unknown'), runId: id }),
]);
export const runRequest = z.object({ taskId: id, runId: id, stage: runStage, mandate, repoKey: id,
  workspace: workspaceRef, input: agentInput, skill: loadedSkill.optional(), execution: executionAttestation,
  attachmentPaths: z.array(id).optional(),
  timeoutMs: z.number().int().positive() });
export type AgentInput = z.infer<typeof agentInput>;
export type AgentEvent = z.infer<typeof agentEvent>;
export interface AgentRunner {
  capabilities(): Record<string, 'supported' | 'unsupported' | 'unverified'>;
  start(request: z.infer<typeof runRequest>): Promise<{ sessionId: string }>;
  resume(request: z.infer<typeof runRequest>): Promise<{ sessionId: string } | { kind: 'unsupported' }>;
  send(sessionId: string, input: AgentInput): Promise<{ kind: 'accepted' | 'unsupported' }>;
  read(sessionId: string): Promise<z.infer<typeof agentSnapshot>>;
  readDurable?(runId: string, sessionId: string): Promise<z.infer<typeof agentSnapshot>>;
  resultSummary?(runId: string, sessionId: string, resultRef: string): Promise<string>;
  cancel(sessionId: string): Promise<{ kind: 'accepted' | 'unsupported' }>;
}
export interface RunRepository { get(id: string): Run | undefined; save(value: Run): void }
export interface RunScheduler { claim(workerId: string): Promise<Run | undefined> }
export interface WorkspaceManager {
  prepare(run: Run): Promise<z.infer<typeof workspaceRef>>;
  verifyDevelopment?(run: Run): Promise<{ baseSha: string; commitSha: string; diffRef: string }>;
  verifyAfterChecks?(run: Run, commitSha: string): Promise<void>;
  prepareCheckCopy?(run: Run): Promise<{ path: string; baseSha: string }>;
  cleanupCheckCopy?(run: Run): Promise<void>;
}
