import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { KernelCoordinator } from '../kernel/model.js';
import type { Task, TaskMandate } from '../task/model.js';
import type { AgentRunner, Run, WorkspaceManager } from './model.js';
import { z } from 'zod';
import { reviewEvidence, type executionAttestation, type developmentEvidence,
  type verificationEvidence, type agentSnapshot } from './model.js';
import type { SkillLoader } from '../../skills/model.js';
import { decide, policyWarning, shouldWarn } from '../../authorization/policy/evaluate.js';
import type { ResolvedReview } from '../../authorization/policy/config.js';
import type { SqliteStore } from '../../storage/sqlite/store.js';
import type { AttachmentReader, AttachmentRef } from '../../event/model.js';

export type ExecutionAttestation = z.infer<typeof executionAttestation>;
type CheckReceipt = z.infer<typeof verificationEvidence>['checks'][number];
export interface VerifyPlan {
  mode: 'agent' | 'platform';
  workspace: 'clone' | 'copy';
  prepare: readonly { command: string; args: readonly string[]; timeoutMs: number }[];
  env: Readonly<Record<string, string>>;
  cacheKeyFiles: readonly string[];
}
const defaultVerifyPlan: VerifyPlan = { mode: 'agent', workspace: 'clone', prepare: [], env: {}, cacheKeyFiles: [] };
const questionOutput = z.object({ kind: z.literal('question'), prompt: z.string().trim().min(1).max(2000) }).strict();
function parseQuestionOutput(summary: string): string | undefined {
  try { return questionOutput.safeParse(JSON.parse(summary)).data?.prompt; }
  catch { return undefined; }
}
export function parseReviewOutput(summary: string): z.infer<typeof reviewEvidence> {
  try { return reviewEvidence.parse(JSON.parse(summary)); }
  catch { /* Qoder may wrap its structured result in one JSON code block. */ }
  const lines = summary.split(/\r?\n/);
  const fences = lines.flatMap((line, index) => line.startsWith('```') ? [index] : []);
  if (!fences.length) {
    const starts = lines.flatMap((line, index) => line.startsWith('{') ? [index] : []);
    if (starts.length !== 1) throw new Error('Review result has no unique final JSON object');
    return reviewEvidence.parse(JSON.parse(lines.slice(starts[0]!).join('\n')));
  }
  if (fences.length !== 2 || !/^```json[ \t]*$/.test(lines[fences[0]!]!) ||
      !/^```[ \t]*$/.test(lines[fences[1]!]!) || fences[1]! <= fences[0]! + 1)
    throw new Error('Review result has no unique JSON code block');
  return reviewEvidence.parse(JSON.parse(lines.slice(fences[0]! + 1, fences[1]!).join('\n')));
}
export interface ExecutionBoundary {
  attest(input: { runId: string; repoKey: string; workspacePath: string; mode: 'read' | 'write';
    mandate: TaskMandate; agentRequired?: boolean; checkWorkspacePath?: string;
    cachePaths?: readonly string[] }): Promise<ExecutionAttestation | undefined>;
  runCheck?(input: { proof: ExecutionAttestation; command: string; args: readonly string[];
    timeoutMs: number; cwd: string; signal: AbortSignal; env?: Readonly<Record<string, string>> }): {
      completion: Promise<{ result: 'passed' | 'failed' | 'timeout' | 'unavailable';
        exitCode: number | null; logRef: string; terminationConfirmed: boolean }>;
      terminate(): Promise<{ terminated: boolean; logRef?: string }>;
    };
  prepareDependencies?(input: { proof: ExecutionAttestation; cwd: string }): Promise<{
    command: string; args: string[]; timeoutMs: number; startedAt: string; endedAt: string;
    result: 'passed' | 'failed' | 'timeout' | 'unavailable'; exitCode: number | null;
    logRef: string; terminationConfirmed: boolean }>;
  release?(proof: ExecutionAttestation): Promise<void>;
}
export function createWorkerManager(input: { store: SqliteStore; coordinator: KernelCoordinator;
  runners: Readonly<Record<string, AgentRunner | undefined>>; enabledAgents: readonly string[];
  workspace: WorkspaceManager; skills: SkillLoader; boundary: ExecutionBoundary;
  riskPolicy?: { assess(task: Task, run: Run): 'low' | 'medium' | 'high' | 'unknown' };
  policyVersion?: string;
  localChecks?: Readonly<Record<string, readonly { command: string; args: readonly string[]; timeoutMs: number }[]>>;
  verifyPlans?: Readonly<Record<string, VerifyPlan | undefined>>;
  cacheRoot?: string;
  agentVerifyEnabled?: boolean;
  attachmentReaders?: Readonly<Record<string, AttachmentReader>>;
  checkLogDirectory?: string;
  skillRepoPath: string; skillCommitSha: string; maxRunMs: number;
  reviewPolicy?: ResolvedReview;
  enabledStages?: readonly Run['stage'][];
  limits: { maxConcurrentRuns: number; perRepoConcurrentRuns: number; perAgentConcurrentRuns: number;
    reservedHumanResume: number } }) {
  const workerId = randomUUID();
  async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), milliseconds);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function unavailableLog(): Promise<string> {
    const directory = resolve(input.checkLogDirectory ?? '.runtime/check-logs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${randomUUID()}.log`);
    await writeFile(path, 'Local check was unavailable or could not complete.\n', { mode: 0o600, flag: 'wx' });
    return path;
  }
  async function checkedLogRef(path: string | undefined): Promise<string> {
    if (path && isAbsolute(path)) {
      try { if ((await stat(path)).isFile()) return path; } catch { /* use a local failure log */ }
    }
    return unavailableLog();
  }
  async function terminateCheck(handle: ReturnType<NonNullable<ExecutionBoundary['runCheck']>>) {
    try { return await bounded(Promise.resolve().then(() => handle.terminate()), 5000); }
    catch { return undefined; }
  }
  const verifyPlanFor = (repoKey: string): VerifyPlan => input.verifyPlans?.[repoKey] ?? defaultVerifyPlan;
  function resolveCheckEnv(plan: VerifyPlan, cachePath: string, checkWorkspace: string): Record<string, string> {
    const values = { CACHE: cachePath, CHECK_WORKSPACE: checkWorkspace } as const;
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(plan.env)) {
      if (!key || /(?:token|secret|password|credential|key|qodercn|agent_platform)/i.test(key) ||
          key.includes('=') || key.includes('\0') || raw.includes('\0'))
        throw new Error(`Check environment variable ${key || '(empty)'} is not allowed`);
      result[key] = raw.replace(/\$\{(CACHE|CHECK_WORKSPACE)\}/g, (_, name: keyof typeof values) => values[name]);
    }
    return result;
  }
  async function prepareCache(plan: VerifyPlan, repoKey: string, workspacePath: string):
    Promise<{ path: string; key: string } | undefined> {
    if (!input.cacheRoot || !plan.cacheKeyFiles.length) return undefined;
    const workspaceRoot = resolve(workspacePath);
    const hash = createHash('sha256');
    for (const file of plan.cacheKeyFiles) {
      const path = resolve(workspaceRoot, file);
      if (!path.startsWith(`${workspaceRoot}/`)) throw new Error('Cache key file is outside the workspace');
      let data: Buffer;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Cache key file is not a regular file');
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      hash.update(file); hash.update('\0'); hash.update(data);
    }
    const key = hash.digest('hex').slice(0, 32);
    const cacheRoot = resolve(input.cacheRoot, repoKey);
    if (cacheRoot === workspaceRoot || cacheRoot.startsWith(`${workspaceRoot}/`) ||
        workspaceRoot.startsWith(`${cacheRoot}/`))
      throw new Error('Dependency cache overlaps the Run workspace');
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const path = resolve(cacheRoot, key);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    const canonicalRoot = await realpath(cacheRoot);
    if (!canonical.startsWith(`${canonicalRoot}/`) || canonical === canonicalRoot)
      throw new Error('Dependency cache escaped its repository root');
    return { path: canonical, key };
  }
  async function runPlatformCheck(command: { command: string; args: readonly string[];
    timeoutMs: number }, cwd: string, env: Readonly<Record<string, string>>,
    proof: ExecutionAttestation): Promise<CheckReceipt> {
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    let handle: ReturnType<NonNullable<ExecutionBoundary['runCheck']>> | undefined;
    let receipt: { result: 'passed' | 'failed' | 'timeout' | 'unavailable';
      exitCode: number | null; logRef: string; terminationConfirmed: boolean };
    try {
      if (!input.boundary.runCheck) {
        receipt = { result: 'unavailable', exitCode: null, logRef: await unavailableLog(),
          terminationConfirmed: true };
      } else {
        handle = input.boundary.runCheck({ proof, command: command.command, args: [...command.args],
          timeoutMs: command.timeoutMs, cwd, signal: controller.signal, env });
        const completed = await bounded(handle.completion, command.timeoutMs);
        if (!completed) {
          controller.abort();
          const stopped = await terminateCheck(handle);
          receipt = { result: stopped?.terminated ? 'timeout' : 'unavailable', exitCode: null,
            logRef: await checkedLogRef(stopped?.logRef), terminationConfirmed: stopped?.terminated === true };
        } else receipt = completed;
      }
      if (!isAbsolute(receipt.logRef) || !(await stat(receipt.logRef)).isFile() ||
          (receipt.result === 'passed' && receipt.exitCode !== 0) ||
          (receipt.result === 'failed' && (receipt.exitCode === null || receipt.exitCode === 0)) ||
          (['timeout', 'unavailable'].includes(receipt.result) && receipt.exitCode !== null) ||
          (receipt.result === 'passed' && !receipt.terminationConfirmed))
        throw new Error('Platform check returned inconsistent evidence');
    } catch {
      controller.abort();
      const stopped = handle ? await terminateCheck(handle) : undefined;
      receipt = { result: 'unavailable', exitCode: null, logRef: await checkedLogRef(stopped?.logRef),
        terminationConfirmed: stopped?.terminated === true };
    }
    return { command: command.command, args: [...command.args], timeoutMs: command.timeoutMs,
      startedAt, endedAt: new Date().toISOString(), ...receipt };
  }
  async function runPlatformVerification(run: Run, task: Task, plan: VerifyPlan):
    Promise<z.infer<typeof verificationEvidence>> {
    if (!run.execution || run.execution.mode !== 'read' || !run.commitSha || !run.workspaceRef ||
        !run.checkWorkspaceRef)
      throw new Error('Platform verification workspace or isolation proof is missing');
    const checkWorkspace = run.checkWorkspaceRef;
    let explicitCache: string | undefined;
    if (run.cacheKey && input.cacheRoot) {
      try { explicitCache = await realpath(resolve(input.cacheRoot, task.repoKey, run.cacheKey)); }
      catch { explicitCache = undefined; }
    }
    const cachePath = explicitCache ?? resolve(checkWorkspace, '.agent-cache');
    await mkdir(cachePath, { recursive: true, mode: 0o700 });
    const env = resolveCheckEnv(plan, cachePath, checkWorkspace);
    const checks: CheckReceipt[] = [];
    let prepareFailed = false;
    let checkCount = 0;
    for (const command of plan.prepare) {
      const receipt = await runPlatformCheck(command, checkWorkspace, env, run.execution);
      checks.push(receipt);
      if (receipt.result !== 'passed' || receipt.exitCode !== 0 || !receipt.terminationConfirmed) {
        prepareFailed = true;
        break;
      }
    }
    if (!prepareFailed) for (const command of input.localChecks?.[task.repoKey] ?? []) {
      checkCount++;
      checks.push(await runPlatformCheck(command, checkWorkspace, env, run.execution));
    }
    const terminationUnconfirmed = checks.some(check => !check.terminationConfirmed);
    let postCheckError: string | undefined;
    if (terminationUnconfirmed) postCheckError = 'Local check process termination is unconfirmed';
    else if (prepareFailed) postCheckError = 'Dependency preparation failed';
    else if (!checkCount) postCheckError = 'No verification checks are configured';
    else {
      try {
        if (!input.workspace.verifyAfterChecks) throw new Error('Post-check Git verifier is unavailable');
        await input.workspace.verifyAfterChecks(run, run.commitSha);
      } catch (error) { postCheckError = error instanceof Error ? error.message : String(error); }
    }
    return { subjectSha: run.commitSha, checks, postCheckVerified: !postCheckError,
      ...(postCheckError ? { postCheckError } : {}),
      ...(explicitCache && run.cacheKey ? { cacheKey: run.cacheKey } : {}) };
  }
  async function startPlatformVerify(claimed: Run, task: Task, plan: VerifyPlan): Promise<boolean> {
    let proof: ExecutionAttestation | undefined;
    let checkCopy: string | undefined;
    let copiedCheckWorkspace = false;
    try {
      const workspace = await input.workspace.prepare(claimed);
      if (workspace.repoKey !== task.repoKey) throw new Error('Workspace repository mismatch');
      if (plan.workspace === 'copy') {
        if (!input.workspace.prepareCheckCopy) throw new Error('Check workspace copy is unavailable');
        await input.workspace.cleanupCheckCopy?.(claimed);
        checkCopy = (await input.workspace.prepareCheckCopy(claimed)).path;
        copiedCheckWorkspace = true;
      } else checkCopy = workspace.path;
      const cache = await prepareCache(plan, task.repoKey, workspace.path);
      proof = await input.boundary.attest({ runId: claimed.id, repoKey: task.repoKey,
        workspacePath: workspace.path, mode: 'read', mandate: task.mandate, agentRequired: false,
        ...(copiedCheckWorkspace ? { checkWorkspacePath: checkCopy } : {}),
        cachePaths: cache ? [cache.path] : [] });
      if (!proof || !proof.verified || proof.runId !== claimed.id || proof.repoKey !== task.repoKey ||
          proof.workspacePath !== workspace.path || proof.mode !== 'read' || !proof.adapterVersion ||
          !proof.configDigest)
        throw new Error('Platform verification isolation is unverified');
      input.store.replaceRun({ ...claimed, status: 'running', workspaceRef: workspace.path,
        checkWorkspaceRef: checkCopy, cacheKey: cache?.key, commitSha: workspace.baseSha,
        execution: proof, startedAt: new Date().toISOString() }, 'running');
      return true;
    } catch (error) {
      if (copiedCheckWorkspace)
        await input.workspace.cleanupCheckCopy?.(claimed).catch(() => {});
      if (proof) await input.boundary.release?.(proof).catch(() => {});
      input.coordinator.onWorkerFailure(claimed.id, error instanceof Error
        ? error.message : 'Platform verification preflight failed', 'pause');
      return true;
    }
  }
  async function finishPlatformVerify(run: Run, task: Task, plan: VerifyPlan): Promise<void> {
    let verification: z.infer<typeof verificationEvidence>;
    try {
      verification = await runPlatformVerification(run, task, plan);
    } catch (error) {
      if (run.checkWorkspaceRef && run.checkWorkspaceRef !== run.workspaceRef)
        await input.workspace.cleanupCheckCopy?.(run).catch(() => {});
      if (run.execution) await input.boundary.release?.(run.execution).catch(() => {});
      input.coordinator.onWorkerFailure(run.id, error instanceof Error
        ? error.message : 'Platform verification failed', 'pause');
      return;
    }
    try {
      await input.coordinator.onSignal({ kind: 'agent_event', taskId: task.id,
        event: { kind: 'result', runId: run.id, status: 'succeeded', exitCode: 0, verification } });
    } finally {
      if (run.checkWorkspaceRef && run.checkWorkspaceRef !== run.workspaceRef)
        await input.workspace.cleanupCheckCopy?.(run).catch(() => {});
      if (run.execution) await input.boundary.release?.(run.execution).catch(() => {});
    }
  }
  async function stageImage(workspacePath: string, sourceId: string, ref: AttachmentRef,
    remainingBytes: number): Promise<{ path: string; bytes: number }> {
    if (ref.kind !== 'image') throw new Error('Agent attachment kind is unsupported');
    const reader = input.attachmentReaders?.[sourceId];
    if (!reader) throw new Error(`Attachment reader is unavailable for source ${sourceId}`);
    const stream = await reader.open(sourceId, ref);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > 10 * 1024 * 1024 || size > remainingBytes)
        throw new Error('Agent image exceeds per-image or per-Run byte limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const hex = bytes.subarray(0, 12).toString('hex');
    const type = hex.startsWith('89504e470d0a1a0a') ? 'png'
      : hex.startsWith('ffd8ff') ? 'jpg'
      : bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a' ? 'gif'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp'
      : undefined;
    if (!type) throw new Error('Agent image format is unsupported');
    const directory = resolve(workspacePath, '.git', 'agent-input');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await realpath(directory);
    if (!(await lstat(directory)).isDirectory() || canonical !== resolve(await realpath(workspacePath), '.git', 'agent-input'))
      throw new Error('Run image input directory is not isolated');
    const path = resolve(canonical, `${randomUUID()}.${type}`);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    return { path, bytes: size };
  }
  async function completeRun(run: Run, snapshot: Extract<z.infer<typeof agentSnapshot>, { kind: 'finished' }>,
    recovered = false): Promise<void> {
    let development: z.infer<typeof developmentEvidence> | undefined;
    let verification: z.infer<typeof verificationEvidence> | undefined;
    let review: z.infer<typeof reviewEvidence> | undefined;
    if ((run.stage === 'develop' || run.stage === 'verify') && snapshot.exitCode === 0 && snapshot.resultRef) {
      try {
        const task = input.store.getTask(run.taskId);
        if (!task || !run.execution || run.execution.mode !== (run.stage === 'develop' ? 'write' : 'read') ||
            run.execution.runId !== run.id || run.execution.repoKey !== task.repoKey ||
            run.execution.workspacePath !== run.workspaceRef || !run.commitSha ||
            (run.stage === 'develop' && (run.commitSha !== task.baseRef || !input.workspace.verifyDevelopment)))
          throw new Error('Run has no matching workspace, SHA or isolation proof');
        const git = run.stage === 'develop' ? await input.workspace.verifyDevelopment!(run)
          : { baseSha: task.baseRef ?? '', commitSha: run.commitSha, diffRef: '' };
        if (run.stage === 'develop' && git.baseSha !== run.commitSha)
          throw new Error('Verified diff base does not match Run');
        const checks: z.infer<typeof developmentEvidence>['checks'] = [];
        let terminationUnconfirmed = false;
        let dependencyFailed = false;
        if (input.localChecks?.[task.repoKey]?.some(check => check.command === 'npm') &&
            input.boundary.prepareDependencies) {
          try {
            const preparation = await input.boundary.prepareDependencies({ proof: run.execution, cwd: run.workspaceRef! });
            checks.push(preparation);
            dependencyFailed = preparation.result !== 'passed' || preparation.exitCode !== 0 ||
              !preparation.terminationConfirmed;
            if (!preparation.terminationConfirmed) terminationUnconfirmed = true;
          } catch {
            checks.push({ command: 'npm', args: ['ci', '--ignore-scripts'], timeoutMs: 180_000,
              startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
              result: 'unavailable', exitCode: null, logRef: await unavailableLog(), terminationConfirmed: false });
            dependencyFailed = true;
            terminationUnconfirmed = true;
          }
        }
        for (const check of input.localChecks?.[task.repoKey] ?? []) {
          const startedAt = new Date().toISOString();
          let receipt: { result: 'passed' | 'failed' | 'timeout' | 'unavailable';
            exitCode: number | null; logRef: string; terminationConfirmed: boolean };
          const controller = new AbortController();
          let handle: ReturnType<NonNullable<ExecutionBoundary['runCheck']>> | undefined;
          const noStart = !input.boundary.runCheck || terminationUnconfirmed || dependencyFailed;
          try {
            if (noStart) receipt = { result: 'unavailable', exitCode: null,
              logRef: await unavailableLog(), terminationConfirmed: true };
            else {
              handle = input.boundary.runCheck!({ proof: run.execution, command: check.command,
                args: check.args, timeoutMs: check.timeoutMs, cwd: run.workspaceRef!, signal: controller.signal });
              const completed = await bounded(handle.completion, check.timeoutMs);
              if (!completed) {
                controller.abort();
                const stopped = await terminateCheck(handle);
                receipt = { result: stopped?.terminated ? 'timeout' : 'unavailable', exitCode: null,
                  logRef: await checkedLogRef(stopped?.logRef), terminationConfirmed: stopped?.terminated === true };
              } else receipt = completed;
            }
            if (!isAbsolute(receipt.logRef) || !(await stat(receipt.logRef)).isFile() ||
                (receipt.result === 'passed' && receipt.exitCode !== 0) ||
                (receipt.result === 'failed' && (receipt.exitCode === null || receipt.exitCode === 0)) ||
                (['timeout', 'unavailable'].includes(receipt.result) && receipt.exitCode !== null) ||
                (receipt.result === 'passed' && !receipt.terminationConfirmed))
              throw new Error('Isolated check returned inconsistent evidence');
          } catch {
            controller.abort();
            const stopped = handle ? await terminateCheck(handle) : undefined;
            receipt = { result: 'unavailable', exitCode: null, logRef: await checkedLogRef(stopped?.logRef),
              terminationConfirmed: noStart || stopped?.terminated === true };
          }
          if (!receipt.terminationConfirmed) terminationUnconfirmed = true;
          checks.push({ ...check, args: [...check.args], startedAt,
            endedAt: new Date().toISOString(), ...receipt });
        }
        let postCheckError: string | undefined;
        if (terminationUnconfirmed) postCheckError = 'Local check process termination is unconfirmed';
        else if (dependencyFailed) postCheckError = 'Dependency preparation failed';
        else {
          try {
            if (!input.workspace.verifyAfterChecks) throw new Error('Post-check Git verifier is unavailable');
            await input.workspace.verifyAfterChecks(run, git.commitSha);
          } catch (error) { postCheckError = error instanceof Error ? error.message : String(error); }
        }
        if (run.stage === 'develop') development = { ...git, checks, postCheckVerified: !postCheckError, postCheckError };
        else verification = { subjectSha: run.commitSha, checks, postCheckVerified: !postCheckError, postCheckError };
      } catch (error) {
        input.store.saveRecord({ id: randomUUID(), taskId: run.taskId, runId: run.id,
          kind: 'agent_report', status: 'failed',
          summary: `${run.stage} evidence rejected: ${error instanceof Error ? error.message : String(error)}`,
          at: new Date().toISOString() });
      }
    }
    if (run.stage === 'review' && snapshot.exitCode === 0 && snapshot.resultRef && run.sessionId && run.commitSha) {
      try {
        const runner = run.agentKind ? input.runners[run.agentKind] : undefined;
        if (!runner?.resultSummary || !run.execution || run.execution.mode !== 'read' ||
            run.execution.workspacePath !== run.workspaceRef || !input.workspace.verifyAfterChecks)
          throw new Error('Review session or isolation proof is missing');
        const summary = await runner.resultSummary(run.id, run.sessionId, snapshot.resultRef);
        if (Buffer.byteLength(summary, 'utf8') > 65_536) throw new Error('Review result exceeds limit');
        review = parseReviewOutput(summary);
        if (review.subjectSha !== run.commitSha) throw new Error('Review result names another SHA');
        await input.workspace.verifyAfterChecks(run, run.commitSha);
      } catch (error) {
        input.store.saveRecord({ id: randomUUID(), taskId: run.taskId, runId: run.id,
          kind: 'agent_report', status: 'failed',
          summary: `Review evidence rejected: ${error instanceof Error ? error.message : String(error)}`,
          at: new Date().toISOString() });
      }
    }
    try {
      if (recovered) await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId, runId: run.id,
        observation: { kind: 'finished', sessionId: run.sessionId!, exitCode: snapshot.exitCode,
          resultRef: snapshot.resultRef, error: snapshot.error, development, verification, review } });
      else await input.coordinator.onSignal({ kind: 'agent_event', taskId: run.taskId,
        event: { kind: 'result', runId: run.id, status: snapshot.exitCode === 0 ? 'succeeded' : 'failed',
          exitCode: snapshot.exitCode, resultRef: snapshot.resultRef, error: snapshot.error,
          development, verification, review } });
    } finally {
      if (run.workspaceRef) await rm(resolve(run.workspaceRef, '.git', 'agent-input'), { recursive: true, force: true });
      if (run.execution) await input.boundary.release?.(run.execution);
    }
  }
  async function settleFinishedRun(run: Run, runner: AgentRunner | undefined,
    snapshot: Extract<z.infer<typeof agentSnapshot>, { kind: 'finished' }>, recovered = false): Promise<void> {
    if (!input.store.openQuestionForRun(run.id) && (run.stage === 'investigate' || run.stage === 'develop') &&
        snapshot.exitCode === 0 && snapshot.resultRef && run.sessionId && runner?.resultSummary) {
      const prompt = parseQuestionOutput(await runner.resultSummary(run.id, run.sessionId, snapshot.resultRef));
      if (prompt) await input.coordinator.onSignal({ kind: 'agent_event', taskId: run.taskId,
        event: { kind: 'question', runId: run.id, questionId: randomUUID(), prompt } });
    }
    if (!input.store.openQuestionForRun(run.id)) { await completeRun(run, snapshot, recovered); return; }
    if (!run.sessionId || !runner?.readDurable) {
      if (recovered) await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId, runId: run.id,
        observation: { kind: 'unknown', reason: 'Question process has no durable termination evidence' } });
      else input.coordinator.onWorkerFailure(run.id, 'Question process has no durable termination evidence', 'pause', true);
      return;
    }
    let durable: z.infer<typeof agentSnapshot>;
    try { durable = await runner.readDurable(run.id, run.sessionId); }
    catch { durable = { kind: 'unknown', runId: run.id }; }
    if (durable.kind !== 'finished' || durable.runId !== run.id || durable.exitCode !== snapshot.exitCode) {
      if (recovered) await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId, runId: run.id,
        observation: { kind: 'unknown', reason: 'Question process termination is unconfirmed' } });
      else input.coordinator.onWorkerFailure(run.id, 'Question process termination is unconfirmed', 'pause', true);
      return;
    }
    if (durable.exitCode !== 0) {
      if (recovered) await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId, runId: run.id,
        observation: { kind: 'finished', sessionId: run.sessionId, exitCode: durable.exitCode } });
      else input.coordinator.onWorkerFailure(run.id, 'Question process exited unsuccessfully', 'pause');
      return;
    }
    try {
      if (run.workspaceRef) await rm(resolve(run.workspaceRef, '.git', 'agent-input'), { recursive: true, force: true });
      if (run.execution) await input.boundary.release?.(run.execution);
    } catch {
      if (recovered) await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId, runId: run.id,
        observation: { kind: 'unknown', reason: 'Question process cleanup failed' } });
      else input.coordinator.onWorkerFailure(run.id, 'Question process cleanup failed', 'pause', true);
      return;
    }
    if (recovered) await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId, runId: run.id,
      observation: { kind: 'finished', sessionId: run.sessionId, exitCode: durable.exitCode } });
    else input.coordinator.onQuestionProcessEnded(run.id, run.sessionId);
  }
  return { async recover(): Promise<number> {
    const rows = input.store.db.prepare(`SELECT id FROM run WHERE
      (status='running' AND (worker_id IS NULL OR worker_id<>?)) OR
      (status='paused' AND json_extract(payload_json,'$.processTerminationUnconfirmed')=1)`)
      .all(workerId);
    for (const row of rows) {
      const run = input.store.getRun(String(row.id));
      if (!run) continue;
      const runner = run.agentKind ? input.runners[run.agentKind] : undefined;
      let snapshot: z.infer<typeof agentSnapshot> | undefined;
      try { if (runner?.readDurable && run.sessionId) snapshot = await runner.readDurable(run.id, run.sessionId); }
      catch { /* Missing durable evidence is an unknown process state. */ }
      if (!snapshot || snapshot.runId !== run.id || snapshot.kind !== 'finished') {
        await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId,
          runId: run.id, observation: { kind: 'unknown', reason: 'Run recovery requires manual process inspection' } });
      } else if (run.status === 'paused') await input.coordinator.onSignal({ kind: 'recovery', taskId: run.taskId,
        runId: run.id, observation: { kind: 'finished', sessionId: run.sessionId!, exitCode: snapshot.exitCode,
          resultRef: snapshot.resultRef, error: snapshot.error } });
      else await settleFinishedRun(run, runner, snapshot, true);
    }
    return rows.length;
  }, async tick(): Promise<boolean> {
    const at = new Date();
    const claimed = input.store.claimRun(workerId, at.toISOString(),
      new Date(at.getTime() + input.maxRunMs + 60_000).toISOString(), input.limits, Object.keys(input.runners),
      input.enabledStages, (run, task) => run.stage !== 'verify' ||
        verifyPlanFor(task.repoKey).mode === 'platform' || input.agentVerifyEnabled !== false);
    if (!claimed) return false;
    const task = input.store.getTask(claimed.taskId);
    if (!task) { input.coordinator.onWorkerFailure(claimed.id, 'Task is missing', 'pause'); return true; }
    const verifyPlan = claimed.stage === 'verify' ? verifyPlanFor(task.repoKey) : undefined;
    if (verifyPlan?.mode === 'platform') return await startPlatformVerify(claimed, task, verifyPlan);
    let launchedSession: string | undefined;
    let launchedRunner: AgentRunner | undefined;
    let attemptedNewSession = false;
    let startedNewSession = false;
    let pendingAnswerIds: string[] = [];
    let pendingEventIds: string[] = [];
    let attested: ExecutionAttestation | undefined;
    let attachmentDirectory: string | undefined;
    try {
      const runner = claimed.agentKind && input.runners[claimed.agentKind];
      if (!runner || !claimed.agentKind || !input.enabledAgents.includes(claimed.agentKind) ||
          runner.capabilities().start !== 'supported') throw new Error('Agent runner is unavailable or unverified');
      const humanResume = claimed.queueClass === 'human_resume';
      if (humanResume && claimed.sessionId &&
          (runner.capabilities().resume !== 'supported' || runner.capabilities().send !== 'supported')) {
        const previous = runner.readDurable
          ? await runner.readDurable(claimed.id, claimed.sessionId) : await runner.read(claimed.sessionId);
        if (previous.kind !== 'finished') throw new Error('Previous session may still be running');
        if (claimed.execution) await input.boundary.release?.(claimed.execution);
      }
      const mode = claimed.stage === 'develop' ? 'write' : 'read';
      const risk = mode === 'write' ? input.riskPolicy?.assess(task, claimed) ?? 'unknown' : 'low';
      const riskRank = { low: 0, medium: 1, high: 2, unknown: 3 } as const;
      if (mode === 'write' && (!task.mandate.allowedActions.includes('edit') ||
          task.mandate.repoKey !== task.repoKey ||
          (input.policyVersion && task.mandate.policyVersion !== input.policyVersion) ||
          risk === 'unknown' || riskRank[risk] > riskRank[task.mandate.maxAutoRisk]))
        throw new Error('Edit Mandate does not authorize this repository');
      if (mode === 'write') {
        const context = { gate: 'edit' as const, repoKey: task.repoKey, taskId: task.id, runId: claimed.id };
        const policy = decide(context, input.reviewPolicy);
        if (shouldWarn(policy) && policy) {
          const at = new Date().toISOString();
          if (!input.store.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='policy_warning'
            AND json_extract(payload_json,'$.ruleId')=? AND json_extract(payload_json,'$.gate')=?`)
            .get(task.id, policy.decision.ruleId, 'edit'))
            input.store.saveRecord({ id: randomUUID(), taskId: task.id, runId: claimed.id, at,
              kind: 'policy_warning', ...policyWarning(context, policy) });
        }
        if (policy?.enforced && policy.decision.effect === 'deny')
          throw new Error(`Policy denied edit: ${policy.decision.reason}`);
      }
      // 临时关闭自定义 Skill 加载：不读取 skills/<stage>/SKILL.md，也不把提示词注入 Qoder。
      // 需要恢复时取消下面注释，并同步恢复 runRequest.skill 与 system-prompt 的 {{skill}} 占位符。
      // const skill = await input.skills.load({ repoRef: input.skillRepoPath,
      //   path: `skills/${claimed.stage}/SKILL.md`, commitSha: input.skillCommitSha, stage: claimed.stage });
      const workspace = await input.workspace.prepare(claimed);
      if (workspace.repoKey !== task.repoKey) throw new Error('Workspace repository mismatch');
      if (claimed.stage === 'investigate' || claimed.stage === 'develop')
        input.store.setTaskBaseRef(task.id, workspace.baseSha);
      const attestation = await input.boundary.attest({ runId: claimed.id, repoKey: task.repoKey, workspacePath: workspace.path,
        mode, mandate: task.mandate });
      attested = attestation;
      if (!attestation || !attestation.verified || attestation.runId !== claimed.id ||
          attestation.repoKey !== task.repoKey || attestation.workspacePath !== workspace.path ||
          attestation.mode !== mode || !attestation.adapterVersion || !attestation.configDigest)
        throw new Error('Execution isolation is unverified');
      const latest = input.store.getTask(task.id);
      if (!latest || latest.iteration !== claimed.iteration || latest.state === 'paused' ||
          (mode === 'write' && !latest.mandate.allowedActions.includes('edit')))
        throw new Error('Task or Mandate changed before CLI start');
      const linkedEvents = input.store.db.prepare("SELECT event_id,status FROM task_record WHERE task_id=? AND kind='event_link' AND status IN ('pending','delivered','handled') ORDER BY at,id")
        .all(task.id).map(row => ({ eventId: String(row.event_id), status: String(row.status) }));
      const initialEventIds = linkedEvents.filter(link => link.status === 'pending').map(link => link.eventId);
      pendingEventIds = initialEventIds;
      const pendingAnswers = humanResume ? input.store.db.prepare("SELECT id FROM task_record WHERE run_id=? AND kind='answer' AND status='pending' ORDER BY at,id")
        .all(claimed.id).map(row => input.store.getRecord(String(row.id))).filter(record => record?.kind === 'answer') : [];
      pendingAnswerIds = pendingAnswers.map(record => record!.id);
      if (humanResume && pendingAnswers.length === 0) throw new Error('Human resume has no pending answer');
      const eventFacts = linkedEvents.map(({ eventId, status }) => {
        const event = input.store.get(eventId);
        if (!event || (event.repoKey && event.repoKey !== task.repoKey)) throw new Error('Linked event is missing or belongs to another repository');
        return { eventId, status, sourceId: event.sourceId, title: event.title, body: event.body,
          attachmentRefs: event.attachments };
      });
      const attachmentPaths: string[] = [];
      if (eventFacts.some(event => event.attachmentRefs.length)) {
        const imageCount = eventFacts.reduce((count, event) => count +
          event.attachmentRefs.filter(ref => ref.kind === 'image').length, 0);
        if (imageCount > 8) throw new Error('Run has more than 8 images');
        if (runner.capabilities().attachments !== 'supported') throw new Error('Agent attachment capability is unavailable');
        attachmentDirectory = resolve(workspace.path, '.git', 'agent-input');
        let totalBytes = 0;
        for (const event of eventFacts) for (const ref of event.attachmentRefs) {
          const staged = await stageImage(workspace.path, event.sourceId, ref, 20 * 1024 * 1024 - totalBytes);
          totalBytes += staged.bytes;
          attachmentPaths.push(staged.path);
        }
      }
      const previousResults = [] as { runId: string; resultRef: string; commitSha?: string;
        conclusion: { kind: 'unverified_agent_conclusion'; text: string } }[];
      const readConclusions = async (taskId: string, excludedRunId: string) => {
        const results: typeof previousResults = [];
        for (const row of input.store.db.prepare("SELECT id FROM run WHERE task_id=? AND id<>? AND status='succeeded' AND result_ref IS NOT NULL ORDER BY ended_at DESC LIMIT 5")
          .all(taskId, excludedRunId)) {
          const previousRun = input.store.getRun(String(row.id));
          const previousRunner = previousRun?.agentKind ? input.runners[previousRun.agentKind] : undefined;
          if (!previousRun || previousRun.taskId !== taskId || previousRun.status !== 'succeeded' ||
              !previousRun.sessionId || !previousRun.resultRef || !previousRunner?.resultSummary)
            throw new Error('Previous Run conclusion cannot be verified for handoff');
          const text = await previousRunner.resultSummary(previousRun.id, previousRun.sessionId, previousRun.resultRef);
          if (!text.trim() || Buffer.byteLength(text, 'utf8') > 8192)
            throw new Error('Previous Run conclusion is missing or exceeds 8 KiB');
          results.push({ runId: previousRun.id, resultRef: previousRun.resultRef,
            commitSha: previousRun.commitSha,
            conclusion: { kind: 'unverified_agent_conclusion', text } });
        }
        return results;
      };
      if (claimed.stage !== 'review') previousResults.push(...await readConclusions(task.id, claimed.id));
      let parentTaskFacts;
      if (task.parentTaskId && claimed.stage !== 'review') {
        const parent = input.store.getTask(task.parentTaskId);
        if (!parent || parent.repoKey !== task.repoKey || parent.id === task.id)
          throw new Error('Related Task is missing or belongs to another repository');
        const developmentEvidence = [] as { runId: string; baseSha: string; commitSha: string; diffRef: string }[];
        for (const row of input.store.db.prepare("SELECT id FROM task_record WHERE task_id=? AND kind='development' ORDER BY at DESC,id LIMIT 5")
          .all(parent.id)) {
          const record = input.store.getRecord(String(row.id));
          if (record?.kind !== 'development' || !record.runId) throw new Error('Related Task evidence is invalid');
          const run = input.store.getRun(record.runId);
          if (run?.taskId === parent.id && run.status === 'succeeded' && record.postCheckVerified &&
              run.commitSha === record.commitSha)
            developmentEvidence.push({ runId: run.id, baseSha: record.baseSha,
              commitSha: record.commitSha, diffRef: record.diffRef });
        }
        parentTaskFacts = { taskId: parent.id, state: parent.state, iteration: parent.iteration,
          title: parent.title.slice(0, 2048), scope: parent.scope.slice(0, 2048),
          baseSha: parent.baseRef, previousResults: await readConclusions(parent.id, claimed.id),
          developmentEvidence };
      }
      let reopenEvidence;
      const reopenedRow = input.store.db.prepare("SELECT id FROM task_record WHERE task_id=? AND kind='reopen' ORDER BY at DESC,id DESC LIMIT 1")
        .get(task.id);
      if (reopenedRow && claimed.stage !== 'review') {
        const record = input.store.getRecord(String(reopenedRow.id));
        if (record?.kind !== 'reopen' || record.nextIteration !== task.iteration)
          throw new Error('Current Task reopening evidence is missing or stale');
        const related = input.store.getTask(record.relatedTaskId);
        const evidenceRun = input.store.getRun(record.evidenceRunId);
        const report = input.store.getRecord(record.evidenceRecordId);
        const previousRunner = evidenceRun?.agentKind ? input.runners[evidenceRun.agentKind] : undefined;
        if (!related || related.parentTaskId !== task.id || related.repoKey !== task.repoKey ||
            related.state !== 'cancelled' || !evidenceRun || evidenceRun.taskId !== related.id ||
            evidenceRun.stage !== 'investigate' || evidenceRun.status !== 'succeeded' ||
            evidenceRun.commitSha !== record.reviewedSha || !evidenceRun.sessionId || !evidenceRun.resultRef ||
            report?.kind !== 'agent_report' || report.status !== 'succeeded' ||
            report.taskId !== related.id || report.runId !== evidenceRun.id || !previousRunner?.resultSummary)
          throw new Error('Related investigation evidence cannot be verified for handoff');
        const text = await previousRunner.resultSummary(evidenceRun.id, evidenceRun.sessionId, evidenceRun.resultRef);
        if (!text.trim() || Buffer.byteLength(text, 'utf8') > 8192)
          throw new Error('Related investigation conclusion is missing or exceeds 8 KiB');
        reopenEvidence = { relatedTaskId: related.id, evidenceRunId: evidenceRun.id,
          finding: record.finding, reviewedSha: record.reviewedSha, resultRef: evidenceRun.resultRef,
          conclusion: { kind: 'unverified_agent_conclusion', text } };
      }
      const answeredFacts = input.store.db.prepare("SELECT id FROM task_record WHERE task_id=? AND kind='answer' AND status IN ('pending','delivered') ORDER BY at,id")
        .all(task.id).map(row => input.store.getRecord(String(row.id)))
        .filter(record => record?.kind === 'answer')
        .map(record => record?.kind === 'answer'
          ? { questionId: record.questionId, content: record.content, status: record.status } : undefined);
      let reviewEvidenceFacts;
      if (claimed.stage === 'review') {
        if (!claimed.commitSha) throw new Error('Review has no pinned SHA');
        const recordRow = input.store.db.prepare(`SELECT id FROM task_record WHERE task_id=? AND kind='development'
          AND json_extract(payload_json,'$.commitSha')=? AND json_extract(payload_json,'$.postCheckVerified')=1
          ORDER BY at DESC LIMIT 1`).get(task.id, claimed.commitSha);
        const record = recordRow ? input.store.getRecord(String(recordRow.id)) : undefined;
        if (record?.kind !== 'development' || !record.diffRef) throw new Error('Review diff evidence is missing');
        const evidenceRoot = await realpath(resolve(input.checkLogDirectory ?? '.runtime/check-logs', '..', 'evidence'));
        const diffPath = await realpath(record.diffRef);
        if (!diffPath.startsWith(`${evidenceRoot}/`) || (await stat(diffPath)).size > 2 * 1024 * 1024)
          throw new Error('Review diff is outside the trusted evidence directory or too large');
        const directory = resolve(workspace.path, '.git', 'agent-input');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const stagedDiff = resolve(directory, 'review.patch');
        await writeFile(stagedDiff, await readFile(diffPath), { mode: 0o600, flag: 'wx' });
        const checks = input.store.db.prepare(`SELECT payload_json FROM task_record WHERE task_id=? AND kind='check'
          AND subject_sha=? ORDER BY at,id`).all(task.id, claimed.commitSha)
          .map(row => JSON.parse(String(row.payload_json)) as { command: string; args: string[];
            result: string; exitCode: number | null; logRef: string });
        reviewEvidenceFacts = { sourceSha: claimed.commitSha, diffPath: stagedDiff,
          checks: checks.map(({ command, args, result, exitCode }) => ({ command, args, result, exitCode })) };
      }
      const facts = { taskId: task.id, iteration: task.iteration, repoKey: task.repoKey,
        scope: task.scope, baseSha: task.baseRef ?? workspace.baseSha, previousResults, parentTaskFacts,
        reopenEvidence: claimed.stage === 'review' ? undefined : reopenEvidence, reviewEvidence: reviewEvidenceFacts,
        events: eventFacts, answers: answeredFacts };
      const reviewContract = claimed.stage === 'review'
        ? `${JSON.stringify(facts)}\n\nYou are the independent reviewer, not the implementer. Do not implement, modify files, run tests, or summarize the change. Return exactly one raw JSON object and nothing else: {"subjectSha":"${claimed.commitSha}","verdict":"pass" or "block","findings":[...]}. If evidence is missing, use verdict "block".`
        : JSON.stringify(facts);
      const request = { taskId: task.id, runId: claimed.id, stage: claimed.stage,
        mandate: latest.mandate, repoKey: latest.repoKey, workspace,
        input: { kind: 'task' as const, runId: claimed.id, prompt: reviewContract,
          sourceEventIds: initialEventIds }, execution: attestation,
        attachmentPaths, timeoutMs: input.maxRunMs };
      let started: { sessionId: string } | { kind: 'unsupported' };
      if (humanResume && claimed.sessionId && runner.capabilities().resume === 'supported' &&
          runner.capabilities().send === 'supported')
        started = await runner.resume(request);
      else started = { kind: 'unsupported' };
      if ('kind' in started) {
        attemptedNewSession = true;
        started = await runner.start(request);
        startedNewSession = true;
        if (claimed.sessionId && started.sessionId === claimed.sessionId)
          throw new Error('New session reused the old session identity');
      }
      launchedSession = started.sessionId;
      launchedRunner = runner;
      input.store.replaceRun({ ...claimed, sessionId: started.sessionId, workspaceRef: workspace.path,
        commitSha: workspace.baseSha, execution: attestation }, 'running');
      if (humanResume && claimed.sessionId && started.sessionId !== claimed.sessionId)
        input.store.saveRecord({ id: randomUUID(), taskId: task.id, runId: claimed.id,
          kind: 'session_handoff', fromSessionId: claimed.sessionId, toSessionId: started.sessionId,
          summary: 'Previous session finished; task facts retained and answer pending delivery',
          at: new Date().toISOString() });
      for (const eventId of initialEventIds)
        input.store.setEventLinkStatus(task.id, eventId, 'pending', 'delivered');
      if (startedNewSession) for (const answerId of pendingAnswerIds)
        input.store.setAnswerStatus(answerId, 'pending', 'delivered');
      await input.coordinator.onSignal({ kind: 'agent_event', taskId: task.id,
        event: { kind: 'progress', runId: claimed.id, text: 'Worker started', at: new Date().toISOString() } });
      return true;
    } catch (error) {
      if (attemptedNewSession) for (const answerId of pendingAnswerIds) {
        const answer = input.store.getRecord(answerId);
        if (answer?.kind === 'answer' && answer.status === 'pending')
          input.store.setAnswerStatus(answerId, 'pending', 'uncertain');
      }
      if (startedNewSession) for (const eventId of pendingEventIds) {
        const link = input.store.db.prepare("SELECT status FROM task_record WHERE task_id=? AND kind='event_link' AND event_id=?")
          .get(task.id, eventId);
        if (link?.status === 'pending') input.store.setEventLinkStatus(task.id, eventId, 'pending', 'uncertain');
      }
      if (launchedSession && launchedRunner) {
        let cancelled: { kind: 'accepted' | 'unsupported' };
        try { cancelled = await launchedRunner.cancel(launchedSession); }
        catch { cancelled = { kind: 'unsupported' }; }
        if (cancelled.kind !== 'accepted') {
          input.coordinator.onWorkerFailure(claimed.id, 'CLI started but cancellation is unconfirmed', 'pause', true);
          return true;
        }
      }
      if (attested) await input.boundary.release?.(attested);
      if (attachmentDirectory) await rm(attachmentDirectory, { recursive: true, force: true });
      const startupTerminated = error instanceof Error &&
        (error as Error & { terminationConfirmed?: boolean }).terminationConfirmed === true;
      input.coordinator.onWorkerFailure(claimed.id, error instanceof Error ? error.message : 'Worker preflight failed',
        'pause', attemptedNewSession && !launchedSession && !startupTerminated);
      return true;
    }
  }, async poll(): Promise<number> {
    const rows = input.store.db.prepare("SELECT id FROM run WHERE status='running' AND worker_id=?").all(workerId);
    let finished = 0;
    for (const row of rows) {
      const run = input.store.getRun(String(row.id))!;
      const task = input.store.getTask(run.taskId);
      const plan = run.stage === 'verify' && task ? verifyPlanFor(task.repoKey) : undefined;
      if (plan?.mode === 'platform' && !run.sessionId) {
        if (!task) { input.coordinator.onWorkerFailure(run.id, 'Task is missing', 'pause'); continue; }
        await finishPlatformVerify(run, task, plan);
        finished++;
        continue;
      }
      const runner = run.agentKind && input.runners[run.agentKind];
      if (!runner || !run.sessionId) { input.coordinator.onWorkerFailure(run.id,
        'Agent session is unavailable', 'pause', true); continue; }
      if (run.startedAt && Date.now() - Date.parse(run.startedAt) > input.maxRunMs) {
        let cancelled: { kind: 'accepted' | 'unsupported' };
        try { cancelled = await runner.cancel(run.sessionId); }
        catch { cancelled = { kind: 'unsupported' }; }
        if (cancelled.kind === 'accepted' && run.execution) await input.boundary.release?.(run.execution);
        if (cancelled.kind === 'accepted' && run.workspaceRef)
          await rm(resolve(run.workspaceRef, '.git', 'agent-input'), { recursive: true, force: true });
        input.coordinator.onWorkerFailure(run.id, cancelled.kind === 'accepted'
          ? 'Run exceeded configured time budget' : 'Run timed out and process termination is unconfirmed',
        'pause', cancelled.kind !== 'accepted');
        continue;
      }
      let snapshot: z.infer<typeof agentSnapshot>;
      try { snapshot = await runner.read(run.sessionId); }
      catch { input.coordinator.onWorkerFailure(run.id, 'Agent process status could not be read', 'pause', true); continue; }
      if (snapshot.runId !== run.id || snapshot.kind === 'unknown') { input.coordinator.onWorkerFailure(run.id,
        snapshot.runId !== run.id ? 'Agent snapshot Run ID does not match the active Run' : 'Agent process state is unknown',
        'pause', true); continue; }
      if (snapshot.kind === 'finished') {
        await settleFinishedRun(run, runner, snapshot);
        finished++;
      } else {
        if (runner.capabilities().send === 'supported') {
          const answers = input.store.db.prepare("SELECT id FROM task_record WHERE run_id=? AND kind='answer' AND status='pending' ORDER BY at,id")
            .all(run.id);
          for (const row of answers) {
            const answer = input.store.getRecord(String(row.id));
            if (!answer || answer.kind !== 'answer') continue;
            try {
              const receipt = await runner.send(run.sessionId, { kind: 'human_answer', questionId: answer.questionId,
                content: answer.content, idempotencyKey: answer.idempotencyKey });
              if (receipt.kind === 'accepted') input.store.setAnswerStatus(answer.id, 'pending', 'delivered');
            } catch { input.store.setAnswerStatus(answer.id, 'pending', 'uncertain'); }
          }
          const links = input.store.db.prepare("SELECT event_id FROM task_record WHERE task_id=? AND kind='event_link' AND status='pending' ORDER BY at,id")
            .all(run.taskId);
          for (const link of links) {
            const eventId = String(link.event_id);
            const event = input.store.get(eventId);
            if (!event) continue;
            try {
              const receipt = await runner.send(run.sessionId, { kind: 'source_followup', eventId, content: event.body });
              if (receipt.kind === 'accepted') input.store.setEventLinkStatus(run.taskId, eventId, 'pending', 'delivered');
            } catch { input.store.setEventLinkStatus(run.taskId, eventId, 'pending', 'uncertain'); }
          }
        }
        input.store.renewRunLease(run.id, workerId, new Date(Date.now() + input.maxRunMs + 60_000).toISOString());
      }
    }
    return finished;
  } };
}
