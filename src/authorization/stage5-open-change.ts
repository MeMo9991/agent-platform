import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteStore } from '../storage/sqlite/store.js';
import type { WorkspaceManager } from '../agent/worker/model.js';
import type { TaskRecord } from '../agent/task/model.js';
import type { CodeHost, repositoryConfig } from '../repository-ci/model.js';
import type { z } from 'zod';
import { evaluateStage5Action } from './stage5-policy.js';
import { autoPrDiffAllowed, autoPrMandate, autoPrPathsAllowed } from './auto-pr.js';
import { decide, policyWarning, shouldWarn, type PolicyOutcome } from './policy/evaluate.js';
import type { ResolvedReview } from './policy/config.js';
import { baseUrl, credential } from '../repository-ci/providers/http.js';
import { changeRef } from '../repository-ci/model.js';
import { checksReady } from '../repository-ci/gate.js';

const git = promisify(execFile);
type Repository = z.infer<typeof repositoryConfig>;
type Result = { kind: 'scope_request' | 'action_request' | 'ready'; requestId?: string;
  sourceSha: string; targetSha: string };

async function pushBranch(repo: Repository, cwd: string, sourceSha: string, branch: string): Promise<void> {
  baseUrl(repo, repo.provider);
  const directory = await mkdtemp(join(tmpdir(), 'agent-platform-push-'));
  const askpass = join(directory, 'askpass');
  try {
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$AGENT_PLATFORM_PUSH_USER";; *Password*) printf "%s\\n" "$AGENT_PLATFORM_PUSH_TOKEN";; *) exit 1;; esac\n',
      { mode: 0o700, flag: 'wx' });
    await git('git', ['-c', 'credential.helper=', 'push', '--porcelain',
      `${repo.hostUrl}/${repo.projectRef}.git`, `${sourceSha}:refs/heads/${branch}`],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
      AGENT_PLATFORM_PUSH_USER: repo.provider === 'github' ? 'x-access-token' : 'oauth2',
      AGENT_PLATFORM_PUSH_TOKEN: credential(repo) }, maxBuffer: 1024 * 1024 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createStage5OpenChange(store: SqliteStore, repositories: Readonly<Record<string, Repository>>,
  hosts: Readonly<Record<string, CodeHost>>, workspace: WorkspaceManager, policyVersion: string,
  push: typeof pushBranch = pushBranch, reviewPolicy?: ResolvedReview) {
  function autoEligible(task: NonNullable<ReturnType<SqliteStore['getTask']>>, repo: Repository,
    review: NonNullable<ReturnType<SqliteStore['latestReview']>>,
    changed: readonly string[], diff: string, sourceSha: string, targetSha: string): boolean {
    const context = { gate: 'openPr' as const, repoKey: repo.repoKey,
      taskId: task.id, baseSha: sourceSha, commitSha: sourceSha, paths: changed, diff,
      review: { verdict: review.verdict, findingsLength: review.findings.length } };
    const policy: PolicyOutcome | undefined = decide(context, reviewPolicy);
    if (shouldWarn(policy) && policy) {
      const at = new Date().toISOString();
      if (!store.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='policy_warning'
        AND json_extract(payload_json,'$.ruleId')=? AND json_extract(payload_json,'$.gate')=?`)
        .get(task.id, policy.decision.ruleId, 'openPr'))
        store.saveRecord({ id: randomUUID(), taskId: task.id, at,
          kind: 'policy_warning', ...policyWarning(context, policy) });
    }
    if (policy?.enforced && policy.decision.effect !== 'allow') return false;
    const event = store.get(task.mandate.sourceEventId);
    const expected = event && autoPrMandate(event, repo, policyVersion);
    if (task.mandate.authority.kind !== 'auto_pr' || expected?.authority.kind !== 'auto_pr' ||
        task.mandate.authority.ruleRef !== expected.authority.ruleRef ||
        review.verdict !== 'pass' || review.findings.length ||
        !autoPrPathsAllowed(changed, repo) || !autoPrDiffAllowed(diff)) return false;
    const decision = evaluateStage5Action({ mandate: task.mandate, repository: repo, action: 'open_pr',
      sourceSha, targetSha, targetBranch: repo.targetBranch, changedPaths: changed, diff, approvalValid: true });
    return decision.kind === 'allow' && decision.risk === 'medium';
  }
  async function facts(taskId: string) {
    const task = store.getTask(taskId);
    const repo = task && repositories[task.repoKey];
    const host = task && hosts[task.repoKey];
    const review = store.latestReview(taskId);
    const sourceSha = store.latestReviewedSha(taskId);
    if (!task || task.state !== 'ready_to_merge' || task.mandate.policyVersion !== policyVersion ||
        !repo || !host || host.repoKey !== repo.repoKey || host.provider !== repo.provider ||
        !host.readTarget || !host.readRequiredChecks || !repo.requiredChecks.length ||
        !review || !sourceSha || review.subjectSha !== sourceSha)
      throw new Error('Task, repository, review or policy is unavailable for opening a change');
    const developmentRow = store.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=? AND kind='development'
      AND json_extract(payload_json,'$.commitSha')=? AND json_extract(payload_json,'$.postCheckVerified')=1
      ORDER BY at DESC,id DESC LIMIT 1`).get(taskId, sourceSha);
    const development = developmentRow && JSON.parse(String(developmentRow.payload_json)) as
      Extract<TaskRecord, { kind: 'development' }> | undefined;
    const run = development?.runId && store.getRun(development.runId);
    if (!development || !run || run.stage !== 'develop' || run.status !== 'succeeded' ||
        run.iteration !== task.iteration || run.commitSha !== sourceSha || !run.workspaceRef ||
        !workspace.verifyAfterChecks)
      throw new Error('Verified development workspace is unavailable');
    await workspace.verifyAfterChecks(run, sourceSha);
    const checks = store.db.prepare(`SELECT record.payload_json FROM task_record AS record
      JOIN run ON run.id=record.run_id WHERE record.task_id=? AND record.kind='check'
      AND run.stage='verify' AND run.status='succeeded' AND run.iteration=?
      AND json_extract(record.payload_json,'$.subjectSha')=?`).all(taskId, task.iteration, sourceSha)
      .map(row => JSON.parse(String(row.payload_json)) as Extract<TaskRecord, { kind: 'check' }>);
    if (!checks.length || checks.some(check => check.result !== 'passed' || check.exitCode !== 0 ||
        !check.terminationConfirmed)) throw new Error('Fixed-SHA verification is incomplete');
    const reviewRun = review.runId && store.getRun(review.runId);
    if (!reviewRun || reviewRun.stage !== 'review' || reviewRun.status !== 'succeeded' ||
        reviewRun.iteration !== task.iteration || reviewRun.commitSha !== sourceSha)
      throw new Error('Independent review Run is incomplete');
    const changed = (await git('git', ['diff', '--name-only', '-z', development.baseSha, sourceSha],
      { cwd: run.workspaceRef, maxBuffer: 1024 * 1024 })).stdout.split('\0').filter(Boolean);
    if (!changed.length) throw new Error('Development diff is empty');
    const diff = (await git('git', ['diff', '--binary', '--no-ext-diff', development.baseSha, sourceSha],
      { cwd: run.workspaceRef, maxBuffer: 10 * 1024 * 1024 })).stdout;
    const targetSha = await host.readTarget(repo.targetBranch);
    await host.readRequiredChecks(repo.targetBranch);
    return { task, repo, host, review, sourceSha, targetSha, changed, diff, sourcePath: run.workspaceRef };
  }
  return {
    async prepare(taskId: string, expectedVersion: number): Promise<Result> {
      const { task, repo, review, sourceSha, targetSha, changed, diff } = await facts(taskId);
      if (task.mandate.authority.kind === 'auto_pr' &&
          !autoEligible(task, repo, review, changed, diff, sourceSha, targetSha))
        throw new Error('Automatic PR candidate is outside the low-risk policy');
      const approvalValid = store.hasActionApproval({ taskId, action: 'open_pr', sourceSha,
        targetBranch: repo.targetBranch, targetSha, policyVersion });
      const decision = evaluateStage5Action({ mandate: task.mandate, repository: repo, action: 'open_pr',
        sourceSha, targetSha, targetBranch: repo.targetBranch, changedPaths: changed, diff, approvalValid });
      if (decision.kind === 'deny') throw new Error(decision.reason);
      const version = () => Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(taskId)?.version);
      if (version() !== expectedVersion) throw new Error('Task version changed before action preflight');
      if (decision.kind === 'allow') return { kind: 'ready', sourceSha, targetSha };
      const requestId = randomUUID();
      store.transaction(() => {
        const current = store.getTask(taskId);
        if (!current || version() !== expectedVersion || current.state !== 'ready_to_merge' ||
            current.mandate.policyVersion !== policyVersion ||
            store.latestReview(taskId)?.id !== review.id || store.latestReviewedSha(taskId) !== sourceSha)
          throw new Error('Task changed before approval request');
        store.saveTransition(taskId, 'waiting_human', decision.reason, new Date().toISOString(),
          randomUUID(), { kind: 'system', id: 'stage5-open-change' });
        if (decision.kind === 'needs_scope') {
          const provisional = evaluateStage5Action({ mandate: { ...current.mandate,
            allowedActions: [...new Set(current.mandate.allowedActions).add('open_pr')], maxAutoRisk: 'high' },
            repository: repo, action: 'open_pr', sourceSha, targetSha,
            targetBranch: repo.targetBranch, changedPaths: changed, diff, approvalValid: false });
          if (provisional.risk === 'unknown') throw new Error('Risk cannot be determined');
          const maxAutoRisk = current.mandate.maxAutoRisk === 'high' || provisional.risk === 'high'
            ? 'high' : current.mandate.maxAutoRisk === 'medium' || provisional.risk === 'medium' ? 'medium' : 'low';
          store.saveApprovalRequest({ kind: 'scope_change', id: requestId, taskId,
            iteration: current.iteration, sourceSha, policyVersion,
            proposedMandate: { ...current.mandate,
              allowedActions: [...new Set(current.mandate.allowedActions).add('open_pr')],
              maxAutoRisk,
              authority: { kind: 'human_approval', approvalRef: requestId } } });
        } else store.saveApprovalRequest({ kind: 'action', id: requestId, taskId,
          action: 'open_pr', sourceSha, reviewRecordId: review.id,
          targetBranch: repo.targetBranch, targetSha, policyVersion });
      });
      return { kind: decision.kind === 'needs_scope' ? 'scope_request' : 'action_request',
        requestId, sourceSha, targetSha };
    },
    async execute(taskId: string, expectedVersion: number): Promise<{ kind: 'opened' | 'uncertain'; changeId?: string }> {
      const { task, repo, host, review, sourceSha, targetSha, changed, diff, sourcePath } = await facts(taskId);
      if (task.mandate.authority.kind === 'auto_pr' &&
          !autoEligible(task, repo, review, changed, diff, sourceSha, targetSha))
        throw new Error('Automatic PR candidate is outside the low-risk policy');
      const approvalValid = store.hasActionApproval({ taskId, action: 'open_pr', sourceSha,
        targetBranch: repo.targetBranch, targetSha, policyVersion });
      const decision = evaluateStage5Action({ mandate: task.mandate, repository: repo, action: 'open_pr',
        sourceSha, targetSha, targetBranch: repo.targetBranch, changedPaths: changed, diff, approvalValid });
      if (decision.kind !== 'allow' || !host.findChangeByBranch)
        throw new Error(`Code-host action is blocked: ${decision.reason}`);
      const branch = `agent-platform/${taskId}`;
      if (!/^agent-platform\/[A-Za-z0-9_-]+$/.test(branch)) throw new Error('Task branch is invalid');
      const intentId = randomUUID();
      const intent = store.transaction(() => {
        const version = Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(taskId)?.version);
        if (version !== expectedVersion || store.getTask(taskId)?.state !== 'ready_to_merge' ||
            !approvalValid)
          throw new Error('Task or approval changed before external action');
        return store.saveEffectIntent({ id: intentId, taskId, kind: 'effect', action: 'open_pr',
          idempotencyKey: `open-pr:${taskId}:${sourceSha}:${targetSha}`, status: 'pending',
          subjectSha: sourceSha, at: new Date().toISOString(), request: { repoKey: repo.repoKey,
            sourceBranch: branch, targetBranch: repo.targetBranch,
            sourceSha, targetSha, policyVersion } });
      });
      if (intent.status === 'done') return { kind: 'opened', changeId: intent.receipt?.changeId };
      let existing: Awaited<ReturnType<NonNullable<CodeHost['findChangeByBranch']>>>;
      try { existing = await host.findChangeByBranch(branch); }
      catch { store.settleEffect(intent.id, 'uncertain'); return { kind: 'uncertain' }; }
      if (existing) {
        if (existing.sourceSha !== sourceSha || existing.targetSha !== targetSha ||
            existing.repoKey !== repo.repoKey) throw new Error('Existing change differs from approved target');
        if ((await host.readChange(existing)).state !== 'open')
          throw new Error('Existing change is not open');
        store.settleEffect(intent.id, 'done', { changeId: existing.id,
          observedSourceSha: sourceSha, observedTargetSha: targetSha, merged: false });
        return { kind: 'opened', changeId: existing.id };
      }
      let recovered = false;
      if (intent.status === 'uncertain' && host.readBranch) {
        const branchSha = await host.readBranch(branch);
        if (branchSha && branchSha !== sourceSha) throw new Error('Task branch differs from approved source SHA');
        if (await host.readTarget?.(repo.targetBranch) !== targetSha)
          throw new Error('Target branch changed before effect recovery');
        store.rearmUncertainEffect(intent.id);
        recovered = true;
      }
      if ((!recovered && intent.id !== intentId) || (intent.status !== 'pending' && !recovered)) {
        if (intent.status === 'pending') store.settleEffect(intent.id, 'uncertain');
        return { kind: 'uncertain' };
      }
      try {
        await push(repo, sourcePath, sourceSha, branch);
        if (await host.readTarget?.(repo.targetBranch) !== targetSha)
          throw new Error('Target branch changed after push');
        const change = await host.openChange({ sourceSha, sourceBranch: branch,
          targetBranch: repo.targetBranch, targetSha, title: task.title });
        if (change.repoKey !== repo.repoKey || change.sourceSha !== sourceSha || change.targetSha !== targetSha ||
            await host.readTarget?.(repo.targetBranch) !== targetSha)
          throw new Error('Created change differs from approved target');
        store.settleEffect(intent.id, 'done', { changeId: change.id,
          observedSourceSha: sourceSha, observedTargetSha: targetSha, merged: false });
        return { kind: 'opened', changeId: change.id };
      } catch {
        try {
          const found = await host.findChangeByBranch(branch);
          if (found && found.repoKey === repo.repoKey && found.sourceSha === sourceSha &&
              found.targetSha === targetSha && (await host.readChange(found)).state === 'open') {
            store.settleEffect(intent.id, 'done', { changeId: found.id,
              observedSourceSha: sourceSha, observedTargetSha: targetSha, merged: false });
            return { kind: 'opened', changeId: found.id };
          }
        } catch { /* External state remains uncertain. */ }
        store.settleEffect(intent.id, 'uncertain');
        return { kind: 'uncertain' };
      }
    },
    async status(taskId: string) {
      const task = store.getTask(taskId);
      const repo = task && repositories[task.repoKey];
      const host = task && hosts[task.repoKey];
      const row = store.db.prepare(`SELECT id FROM task_record WHERE task_id=? AND kind='effect'
        AND json_extract(payload_json,'$.action')='open_pr' AND status='done'
        ORDER BY at DESC,id DESC LIMIT 1`).get(taskId);
      const effect = row && store.getRecord(String(row.id));
      if (!task || !repo || !host || host.repoKey !== repo.repoKey ||
          host.provider !== repo.provider || !host.readRequiredChecks ||
          effect?.kind !== 'effect' || !effect.request || !effect.receipt ||
          effect.request.repoKey !== repo.repoKey || effect.request.targetBranch !== repo.targetBranch)
        throw new Error('Code-host change is unavailable');
      const change = changeRef.parse({ provider: repo.provider, repoKey: repo.repoKey,
        id: effect.receipt.changeId, sourceSha: effect.request.sourceSha,
        targetSha: effect.request.targetSha });
      const snapshot = await host.readChange(change);
      const requiredChecks = [...new Set([...repo.requiredChecks,
        ...await host.readRequiredChecks(repo.targetBranch)])];
      const ready = snapshot.sourceSha === effect.request.sourceSha &&
        snapshot.targetSha === effect.request.targetSha &&
        store.latestReviewedSha(taskId) === effect.request.sourceSha &&
        task.mandate.policyVersion === effect.request.policyVersion &&
        checksReady(snapshot, requiredChecks);
      const observation = { subjectSha: snapshot.sourceSha, targetSha: snapshot.targetSha,
        changeId: change.id, state: snapshot.state, gate: snapshot.gate,
        ready, requiredChecks, checks: snapshot.checks };
      store.transaction(() => {
        const current = store.getTask(taskId);
        if (!current || current.iteration !== task.iteration || current.mandate.policyVersion !== task.mandate.policyVersion)
          throw new Error('Task changed while reading CI');
        const priorRow = store.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=? AND kind='ci'
          ORDER BY at DESC,id DESC LIMIT 1`).get(taskId);
        const prior = priorRow && JSON.parse(String(priorRow.payload_json)) as Record<string, unknown>;
        if (prior && JSON.stringify(Object.fromEntries(Object.entries(prior)
          .filter(([key]) => !['id', 'taskId', 'kind', 'at'].includes(key)))) === JSON.stringify(observation)) return;
        store.saveRecord({ id: randomUUID(), taskId, kind: 'ci', ...observation,
          at: snapshot.observedAt });
      });
      return observation;
    },
    async prepareMerge(taskId: string, expectedVersion: number): Promise<{
      kind: 'scope_request' | 'action_request' | 'manual_ready'; requestId?: string;
      sourceSha: string; targetSha: string; changeId: string }> {
      const ci = await this.status(taskId);
      if (!ci.ready || ci.state !== 'open') throw new Error('Current source, target or CI gate is not ready');
      const { task, repo, review, sourceSha, targetSha, changed, diff } = await facts(taskId);
      if (ci.subjectSha !== sourceSha || ci.targetSha !== targetSha)
        throw new Error('Merge target changed during preflight');
      const approvalValid = store.hasActionApproval({ taskId, action: 'merge', sourceSha,
        targetBranch: repo.targetBranch, targetSha, changeRef: ci.changeId, policyVersion });
      const decision = evaluateStage5Action({ mandate: task.mandate, repository: repo, action: 'merge',
        sourceSha, targetSha, targetBranch: repo.targetBranch, changedPaths: changed, diff, approvalValid });
      if (decision.kind === 'deny') throw new Error(decision.reason);
      const version = () => Number(store.db.prepare('SELECT version FROM task WHERE id=?').get(taskId)?.version);
      if (version() !== expectedVersion) throw new Error('Task version changed before merge preflight');
      if (decision.kind === 'allow') {
        store.transaction(() => {
          if (version() !== expectedVersion || store.getTask(taskId)?.state !== 'ready_to_merge' ||
              !store.hasActionApproval({ taskId, action: 'merge', sourceSha,
                targetBranch: repo.targetBranch, targetSha, changeRef: ci.changeId, policyVersion }))
            throw new Error('Merge approval changed before manual handoff');
          store.saveEffectIntent({ id: randomUUID(), taskId, kind: 'effect', action: 'merge',
            idempotencyKey: `merge:${taskId}:${sourceSha}:${targetSha}:${ci.changeId}`,
            status: 'pending', subjectSha: sourceSha, at: new Date().toISOString(),
            request: { repoKey: repo.repoKey, targetBranch: repo.targetBranch, sourceSha,
              targetSha, changeId: ci.changeId, policyVersion } });
        });
        return { kind: 'manual_ready', sourceSha, targetSha, changeId: ci.changeId };
      }
      const requestId = randomUUID();
      store.transaction(() => {
        const current = store.getTask(taskId);
        if (!current || version() !== expectedVersion || current.state !== 'ready_to_merge' ||
            store.latestReview(taskId)?.id !== review.id || store.latestReviewedSha(taskId) !== sourceSha)
          throw new Error('Task changed before merge approval request');
        store.saveTransition(taskId, 'waiting_human', decision.reason, new Date().toISOString(),
          randomUUID(), { kind: 'system', id: 'stage5-merge' });
        if (decision.kind === 'needs_scope') store.saveApprovalRequest({ kind: 'scope_change',
          id: requestId, taskId, iteration: current.iteration, sourceSha, policyVersion,
          proposedMandate: { ...current.mandate,
            allowedActions: [...new Set(current.mandate.allowedActions).add('merge')],
            maxAutoRisk: 'high', authority: { kind: 'human_approval', approvalRef: requestId } } });
        else store.saveApprovalRequest({ kind: 'action', id: requestId, taskId,
          action: 'merge', sourceSha, reviewRecordId: review.id, changeRef: ci.changeId,
          targetBranch: repo.targetBranch, targetSha, policyVersion });
      });
      return { kind: decision.kind === 'needs_scope' ? 'scope_request' : 'action_request',
        requestId, sourceSha, targetSha, changeId: ci.changeId };
    },
    async observeManualMerge(taskId: string): Promise<'pending' | 'merged'> {
      const task = store.getTask(taskId);
      const repo = task && repositories[task.repoKey];
      const host = task && hosts[task.repoKey];
      const row = store.db.prepare(`SELECT id FROM task_record WHERE task_id=? AND kind='effect'
        AND json_extract(payload_json,'$.action')='merge' ORDER BY at DESC,id DESC LIMIT 1`).get(taskId);
      const effect = row && store.getRecord(String(row.id));
      if (!task || !repo || !host || host.repoKey !== repo.repoKey ||
          host.provider !== repo.provider || effect?.kind !== 'effect' ||
          !effect.request?.changeId || effect.request.repoKey !== repo.repoKey ||
          effect.request.targetBranch !== repo.targetBranch)
        throw new Error('Manual merge intent is unavailable');
      if (effect.status === 'done') {
        if (task.state !== 'release_pending') throw new Error('Merge receipt and Task state disagree');
        return 'merged';
      }
      if (!['pending', 'uncertain'].includes(effect.status) || task.state !== 'ready_to_merge' ||
          !store.hasActionApproval({ taskId, action: 'merge', sourceSha: effect.request.sourceSha,
            targetBranch: repo.targetBranch, targetSha: effect.request.targetSha,
            changeRef: effect.request.changeId, policyVersion: effect.request.policyVersion }))
        throw new Error('Manual merge approval is stale');
      const snapshot = await host.readChange(changeRef.parse({ provider: repo.provider,
        repoKey: repo.repoKey, id: effect.request.changeId,
        sourceSha: effect.request.sourceSha, targetSha: effect.request.targetSha }));
      if (snapshot.state !== 'merged') return 'pending';
      if (snapshot.change.id !== effect.request.changeId ||
          snapshot.sourceSha !== effect.request.sourceSha ||
          snapshot.preMergeTargetSha !== effect.request.targetSha ||
          !snapshot.mergedSha || !/^[a-f0-9]{40}$/.test(snapshot.mergedSha))
        throw new Error('Merged commit does not prove the approved source and target');
      store.transaction(() => {
        const current = store.getTask(taskId);
        if (!current || current.state !== 'ready_to_merge' ||
            !store.hasActionApproval({ taskId, action: 'merge', sourceSha: effect.request!.sourceSha,
              targetBranch: repo.targetBranch, targetSha: effect.request!.targetSha,
              changeRef: effect.request!.changeId, policyVersion: effect.request!.policyVersion }))
          throw new Error('Manual merge approval changed before receipt');
        store.settleEffect(effect.id, 'done', { changeId: effect.request!.changeId!,
          observedSourceSha: effect.request!.sourceSha,
          observedTargetSha: snapshot.preMergeTargetSha!, merged: true, mergedSha: snapshot.mergedSha });
        const at = snapshot.observedAt;
        const actor = { kind: 'system' as const, id: 'code-host' };
        store.saveTransition(taskId, 'merging', 'Platform merge receipt verified', at, randomUUID(), actor);
        store.saveTransition(taskId, 'merged', 'Platform confirmed merged commit', at, randomUUID(), actor);
        store.saveTransition(taskId, 'release_pending', 'Merge completed; release remains pending',
          at, randomUUID(), actor);
      });
      return 'merged';
    },
  };
}
