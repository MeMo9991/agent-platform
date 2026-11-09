import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { z } from 'zod';
import type { SqliteStore } from '../storage/sqlite/store.js';
import { developmentEvidence, type AgentRunner, type Run, type WorkspaceManager } from '../agent/worker/model.js';
import type { Task } from '../agent/task/model.js';
import type { ExecutionBoundary } from '../agent/worker/manager.js';
import type { TaskCommand } from '../interaction/task-command.js';

type RunningCommand = Exclude<TaskCommand, { kind: 'split' | 'takeover_result' }>;
type TakeoverResult = Extract<TaskCommand, { kind: 'takeover_result' }>;
export type TakeoverEvidencePorts = { workspace: WorkspaceManager; boundary: ExecutionBoundary;
  localChecks: Readonly<Record<string, readonly { command: string; args: readonly string[]; timeoutMs: number }[]>>;
  policyVersion: string };
const validatingTakeovers = new WeakMap<SqliteStore, Set<string>>();

async function verifyTakeoverCode(task: Task, previous: Run, input: TakeoverResult,
  ports: TakeoverEvidencePorts | undefined): Promise<z.infer<typeof developmentEvidence> | undefined> {
  if (!ports || !previous.workspaceRef || !previous.commitSha || previous.iteration !== task.iteration ||
      task.baseRef !== previous.commitSha || task.mandate.policyVersion !== ports.policyVersion)
    throw new Error('Takeover workspace, base SHA or policy cannot be verified');
  if (input.codeChange === 'none') {
    if (input.commitSha) throw new Error('A commit SHA requires committed code evidence');
    const workspace = await ports.workspace.prepare(previous);
    if (workspace.repoKey !== task.repoKey || workspace.path !== previous.workspaceRef ||
        workspace.baseSha !== previous.commitSha)
      throw new Error('Takeover workspace changed or belongs to another repository');
    return undefined;
  }
  if (!input.commitSha || previous.stage !== 'develop' || !task.mandate.allowedActions.includes('edit') ||
      !previous.execution || previous.execution.mode !== 'write' || previous.execution.runId !== previous.id ||
      previous.execution.repoKey !== task.repoKey || previous.execution.workspacePath !== previous.workspaceRef ||
      !ports.workspace.verifyDevelopment || !ports.workspace.verifyAfterChecks || !ports.boundary.runCheck)
    throw new Error('Committed takeover lacks edit authorization or verified execution boundary');
  const git = await ports.workspace.verifyDevelopment(previous);
  if (git.baseSha !== previous.commitSha || git.commitSha !== input.commitSha)
    throw new Error('Submitted commit SHA does not match the verified nonempty diff');
  const configured = ports.localChecks[task.repoKey] ?? [];
  if (!configured.length) throw new Error('No trusted local checks are configured');
  const checks: z.infer<typeof developmentEvidence>['checks'] = [];
  for (const check of configured) {
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const handle = ports.boundary.runCheck({ proof: previous.execution, command: check.command,
      args: check.args, timeoutMs: check.timeoutMs, cwd: previous.workspaceRef, signal: controller.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([handle.completion, new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), check.timeoutMs);
      })]);
      if (!receipt) throw new Error('Local check timed out');
      if (receipt.result !== 'passed' || receipt.exitCode !== 0 || !receipt.terminationConfirmed ||
          !isAbsolute(receipt.logRef) || !(await stat(receipt.logRef)).isFile())
        throw new Error('Local check did not produce passing, terminated evidence');
      checks.push({ ...check, args: [...check.args], startedAt,
        endedAt: new Date().toISOString(), ...receipt });
    } catch (error) {
      controller.abort();
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([handle.terminate().catch(() => ({ terminated: false })),
        new Promise<{ terminated: false }>(resolve => {
          stopTimer = setTimeout(() => resolve({ terminated: false }), 5000);
        })]);
      if (stopTimer) clearTimeout(stopTimer);
      if (!stopped.terminated) throw new Error('Local check termination is unconfirmed');
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  await ports.workspace.verifyAfterChecks(previous, git.commitSha);
  return developmentEvidence.parse({ ...git, checks, postCheckVerified: true });
}

export async function executeTaskCommand(store: SqliteStore, runners: Readonly<Record<string, AgentRunner | undefined>>,
  actorId: string, input: RunningCommand): Promise<{ taskId: string; version: number }> {
  const prior = store.db.prepare('SELECT * FROM dashboard_command WHERE idempotency_key=?')
    .get(input.idempotencyKey);
  if (prior) {
    if (prior.task_id === input.taskId && prior.kind === input.kind && prior.actor_id === actorId && prior.reason === input.reason)
      return { taskId: input.taskId, version: Number(prior.task_version) };
    throw new Error('Idempotency key belongs to another command');
  }
  const row = store.db.prepare('SELECT version FROM task WHERE id=?').get(input.taskId);
  const task = store.getTask(input.taskId);
  if (!task || Number(row?.version) !== input.expectedVersion) throw new Error('Task version changed; reload before deciding');
  if (task.owner && ['resume', 'retry', 'cancel'].includes(input.kind))
    throw new Error('Human takeover result is required first');
  if (!input.reason.trim()) throw new Error('Reason is required');
  const latestReview = input.kind === 'retry' && task.state === 'waiting_human' ? store.latestReview(task.id) : undefined;
  const retryEmptyReview = latestReview?.verdict === 'block' && latestReview.findings.length === 0;
  if (['resume', 'retry'].includes(input.kind) && !['paused', 'failed', 'blocked'].includes(task.state) && !retryEmptyReview)
    throw new Error('Task is not ready to resume or retry');
  if (['pause', 'takeover'].includes(input.kind) && !['queued', 'investigating', 'developing', 'waiting_human'].includes(task.state))
    throw new Error('Task cannot be paused or taken over now');
  if (input.kind === 'cancel' && !['new', 'triaged', 'queued', 'investigating', 'developing', 'waiting_human',
    'paused', 'blocked', 'failed'].includes(task.state)) throw new Error('Task cannot be cancelled now');
  const active = store.db.prepare("SELECT id FROM run WHERE task_id=? AND status IN ('running','queued','waiting_human') ORDER BY created_at DESC LIMIT 1")
    .get(task.id);
  const run = active ? store.getRun(String(active.id)) : undefined;
  if (run?.status === 'waiting_human' && ['pause', 'takeover'].includes(input.kind))
    throw new Error('Resolve the pending human request before this command');
  if (['pause', 'takeover'].includes(input.kind) && store.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND kind IN ('question','approval_request') AND status='open' LIMIT 1").get(task.id))
    throw new Error('Resolve the pending human request before this command');
  if (run?.status === 'running') {
    const runner = run.agentKind && runners[run.agentKind];
    if (!runner || !run.sessionId || (await runner.cancel(run.sessionId)).kind !== 'accepted')
      throw new Error('Agent termination is unconfirmed; command was not applied');
  }
  return store.transaction(() => {
    const current = store.getTask(input.taskId);
    const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(input.taskId)?.version);
    if (!current || version !== input.expectedVersion) throw new Error('Task version changed; reload before deciding');
    if (!input.reason.trim()) throw new Error('Reason is required');
    const now = new Date().toISOString();
    const actor = { kind: 'human' as const, id: actorId };
    if (input.kind === 'pause' || input.kind === 'takeover' || input.kind === 'cancel') {
      if (run) store.replaceRun({ ...run, status: 'cancelled', leaseUntil: undefined,
        workerId: undefined, endedAt: now }, run.status);
      if (input.kind === 'cancel') {
        for (const row of store.db.prepare("SELECT id,payload_json,kind FROM task_record WHERE task_id=? AND kind IN ('question','approval_request') AND status='open'").all(current.id)) {
          const record = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
          const status = row.kind === 'question' ? 'dismissed' : 'invalidated';
          store.db.prepare('UPDATE task_record SET status=?,payload_json=? WHERE id=? AND status=\'open\'')
            .run(status, JSON.stringify({ ...record, status }), row.id);
        }
        store.saveTransition(current.id, 'cancelled', input.reason, now, randomUUID(), actor);
      }
      else {
        if (current.state !== 'queued' && current.state !== 'waiting_human' && current.state !== 'paused')
          store.saveTransition(current.id, 'waiting_human', 'Agent stopped for human command', now, randomUUID(), actor);
        if (current.state !== 'paused') store.saveTransition(current.id, 'paused', input.reason, now, randomUUID(), actor);
        if (input.kind === 'takeover') {
          const updated = store.getTask(current.id)!;
          store.db.prepare('UPDATE task SET owner=?,payload_json=? WHERE id=?')
            .run(actorId, JSON.stringify({ ...updated, owner: actorId }), current.id);
        }
      }
    } else {
      if ((!['paused', 'failed', 'blocked'].includes(current.state) && !retryEmptyReview) || store.hasActiveRun(current.id))
        throw new Error('Task is not ready to resume or retry');
      const last = store.db.prepare('SELECT id FROM run WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(current.id);
      const previous = last ? store.getRun(String(last.id)) : undefined;
      if (retryEmptyReview) {
        const review = store.latestReview(current.id);
        if (current.state !== 'waiting_human' || !review || review.verdict !== 'block' || review.findings.length ||
            !previous || previous.id !== review.runId || previous.stage !== 'review' ||
            previous.status !== 'succeeded' || previous.iteration !== current.iteration ||
            previous.commitSha !== review.subjectSha || !previous.agentKind ||
            store.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND kind IN ('question','approval_request') AND status='open' LIMIT 1").get(current.id))
          throw new Error('No pinned, empty blocking review is available for retry');
        store.saveTransition(current.id, 'reviewing', input.reason, now, randomUUID(), actor);
        store.saveRun({ id: randomUUID(), taskId: current.id, iteration: current.iteration,
          stage: 'review', status: 'queued', requestKey: `command:${input.idempotencyKey}`,
          priority: current.priority, attempt: previous.attempt + 1, agentKind: previous.agentKind,
          commitSha: previous.commitSha, createdAt: now });
      } else {
        const retryVerify = previous?.stage === 'verify' && previous.status === 'failed' &&
          previous.commitSha && /^[a-f0-9]{40}$/.test(previous.commitSha) &&
          store.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='development'
            AND json_extract(payload_json,'$.commitSha')=? AND json_extract(payload_json,'$.postCheckVerified')=1
            LIMIT 1`).get(current.id, previous.commitSha);
        const retryReview = previous?.stage === 'review' && previous.status === 'failed' &&
          previous.commitSha && /^[a-f0-9]{40}$/.test(previous.commitSha) &&
          store.db.prepare("SELECT 1 FROM run WHERE task_id=? AND stage='verify' AND status='succeeded' AND commit_sha=? LIMIT 1")
            .get(current.id, previous.commitSha) &&
          !store.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND run_id=? AND kind='review' LIMIT 1")
            .get(current.id, previous.id);
        const review = store.latestReview(current.id);
        const retryUnsupportedReview = current.state === 'blocked' && previous?.stage === 'develop' && previous.status === 'failed' &&
          previous.iteration === current.iteration && review?.verdict === 'pass' && review.runId &&
          review.subjectSha === previous.commitSha &&
          review.findings.some(finding => !['low', 'medium', 'high', 'unknown'].includes(finding.severity)) &&
          store.db.prepare("SELECT 1 FROM run WHERE id=? AND task_id=? AND stage='review' AND status='succeeded' AND commit_sha=? LIMIT 1")
            .get(review.runId, current.id, review.subjectSha) &&
          store.db.prepare("SELECT 1 FROM run WHERE task_id=? AND stage='verify' AND status='succeeded' AND commit_sha=? LIMIT 1")
            .get(current.id, review.subjectSha) &&
          !store.db.prepare("SELECT 1 FROM task_record WHERE task_id=? AND run_id=? AND kind='development' LIMIT 1")
            .get(current.id, previous.id);
        if (!previous || !(['investigate', 'develop'].includes(previous.stage) || retryVerify || retryReview ||
            retryUnsupportedReview) || !previous.agentKind)
          throw new Error('No safe Run stage is available for retry');
        store.saveTransition(current.id, 'queued', input.reason, now, randomUUID(), actor);
        const next: Run = { id: randomUUID(), taskId: current.id, iteration: current.iteration,
          stage: retryUnsupportedReview ? 'review' : previous.stage, status: 'queued',
          requestKey: `command:${input.idempotencyKey}`,
          priority: current.priority, attempt: previous.attempt + 1, agentKind: previous.agentKind,
          commitSha: retryVerify || retryReview || retryUnsupportedReview ? previous.commitSha : undefined,
          createdAt: now };
        store.saveRun(next);
      }
    }
    const nextVersion = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(current.id)?.version);
    store.db.prepare('INSERT INTO dashboard_command(idempotency_key,actor_id,task_id,kind,reason,task_version) VALUES (?,?,?,?,?,?)')
      .run(input.idempotencyKey, actorId, current.id, input.kind, input.reason, nextVersion);
    return { taskId: current.id, version: nextVersion };
  });
}

export async function completeTakeover(store: SqliteStore, actorId: string, input: TakeoverResult,
  ports?: TakeoverEvidencePorts): Promise<{ taskId: string; version: number }> {
  const reason = JSON.stringify({ summary: input.summary, disposition: input.disposition,
    codeChange: input.codeChange, commitSha: input.commitSha ?? null });
  const prior = store.db.prepare('SELECT * FROM dashboard_command WHERE idempotency_key=?').get(input.idempotencyKey);
  if (prior) {
    if (prior.actor_id === actorId && prior.task_id === input.taskId && prior.kind === `takeover_${input.disposition}` &&
        (prior.reason === reason || (input.codeChange === 'none' && !input.commitSha && prior.reason === input.summary)))
      return { taskId: input.taskId, version: Number(prior.task_version) };
    throw new Error('Idempotency key belongs to another command');
  }
  const task = store.getTask(input.taskId);
  const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(input.taskId)?.version);
  if (!task || version !== input.expectedVersion) throw new Error('Task version changed; reload before deciding');
  if (task.state !== 'paused' || task.owner !== actorId || !input.summary.trim())
    throw new Error('Human takeover result does not match the paused Task owner');
  if (input.disposition === 'cancel' && (input.codeChange !== 'none' || input.commitSha))
    throw new Error('Code evidence can only be submitted when resuming the Task');
  const row = store.db.prepare('SELECT id FROM run WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(task.id);
  const previous = row ? store.getRun(String(row.id)) : undefined;
  if (input.disposition === 'resume' && (!previous || !['investigate', 'develop'].includes(previous.stage) ||
      !previous.agentKind || store.hasActiveRun(task.id)))
    throw new Error('No safe Run stage is available after takeover');
  const validating = validatingTakeovers.get(store) ?? new Set<string>();
  validatingTakeovers.set(store, validating);
  if (validating.has(task.id)) throw new Error('Takeover validation is already running');
  validating.add(task.id);
  try {
    const evidence = input.disposition === 'resume' ? await verifyTakeoverCode(task, previous!, input, ports) : undefined;
    return store.transaction(() => {
    const current = store.getTask(input.taskId);
    const currentVersion = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(input.taskId)?.version);
    if (!current || currentVersion !== input.expectedVersion || current.state !== 'paused' || current.owner !== actorId ||
        (previous && JSON.stringify(store.getRun(previous.id)) !== JSON.stringify(previous)) || store.hasActiveRun(input.taskId))
      throw new Error('Takeover facts changed during validation; reload before deciding');
    const at = new Date().toISOString();
    const actor = { kind: 'human' as const, id: actorId };
    let next: Run | undefined;
    if (input.disposition === 'resume') {
      next = { id: randomUUID(), taskId: task.id, iteration: task.iteration,
        stage: evidence ? 'verify' : previous!.stage,
        status: 'queued', requestKey: `takeover:${input.idempotencyKey}`, priority: task.priority,
        attempt: previous!.attempt + 1, agentKind: previous!.agentKind,
        commitSha: evidence?.commitSha, createdAt: at };
    }
    let developmentRecordId: string | undefined;
    if (evidence) {
      developmentRecordId = randomUUID();
      store.saveRecord({ id: developmentRecordId, taskId: task.id, runId: previous!.id, kind: 'development',
        baseSha: evidence.baseSha, commitSha: evidence.commitSha, diffRef: evidence.diffRef,
        postCheckVerified: true, at });
      for (const check of evidence.checks) store.saveRecord({ id: randomUUID(), taskId: task.id,
        runId: previous!.id, kind: 'check', subjectSha: evidence.commitSha, ...check, at });
    }
    store.saveRecord({ id: randomUUID(), taskId: task.id, kind: 'human_result', actor,
      summary: input.summary, disposition: input.disposition, idempotencyKey: input.idempotencyKey,
      codeChange: input.codeChange, commitSha: evidence?.commitSha, developmentRecordId, at });
    store.saveTransition(task.id, input.disposition === 'cancel' ? 'cancelled' : evidence ? 'verifying' : 'queued',
      'Human takeover completed', at, randomUUID(), actor);
    if (next) store.saveRun(next);
    const updated = store.getTask(task.id)!;
    store.db.prepare('UPDATE task SET owner=NULL,payload_json=? WHERE id=? AND owner=?')
      .run(JSON.stringify({ ...updated, owner: undefined }), task.id, actorId);
    const nextVersion = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(task.id)?.version);
    store.db.prepare('INSERT INTO dashboard_command(idempotency_key,actor_id,task_id,kind,reason,task_version) VALUES (?,?,?,?,?,?)')
      .run(input.idempotencyKey, actorId, task.id, `takeover_${input.disposition}`, reason, nextVersion);
    return { taskId: task.id, version: nextVersion };
    });
  } finally { validating.delete(task.id); }
}
