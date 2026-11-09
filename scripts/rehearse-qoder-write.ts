import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMacQoderRuntime } from '../src/agent/worker/mac-sandbox.js';
import { createQoderRunner } from '../src/agent/worker/agents/qoder.js';
import { createGitWorkspaceManager } from '../src/agent/worker/workspace.js';
import type { Run } from '../src/agent/worker/model.js';

if (!process.env.QODERCN_PERSONAL_ACCESS_TOKEN) throw new Error('QODERCN_PERSONAL_ACCESS_TOKEN is required');
const parent = resolve('.runtime/write-rehearsal');
mkdirSync(parent, { recursive: true, mode: 0o700 });
chmodSync(parent, 0o700);
const root = mkdtempSync(join(parent, 'probe-'));
const repo = join(root, 'source');
const remote = 'https://example.invalid/stage5-write-probe.git';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
mkdirSync(repo);
git(repo, 'init', '-q');
git(repo, 'remote', 'add', 'origin', remote);
writeFileSync(join(repo, 'probe.txt'), 'before\n');
git(repo, 'add', 'probe.txt');
git(repo, '-c', 'user.name=Stage5 Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'base');
const baseSha = git(repo, 'rev-parse', 'HEAD');
const runId = 'write-probe';
const run: Run = { id: runId, taskId: 'write-probe-task', iteration: 1, stage: 'develop',
  status: 'running', priority: 0, attempt: 1, commitSha: baseSha, createdAt: new Date().toISOString() };
const workspace = createGitWorkspaceManager({ probe: { path: repo, remote } }, root, () => 'probe');
const prepared = await workspace.prepare(run);
const activeRun = { ...run, workspaceRef: prepared.path };
const runtime = await createMacQoderRuntime({ cloneRoot: join(root, 'clones'),
  profileRoot: join(root, 'profiles'), qoderPath: join(homedir(), '.local/bin/qoderclicn'), writeEnabled: true });
const mandate = { sourceEventId: 'write-probe-event', repoKey: 'probe', goal: 'Isolated write rehearsal',
  allowedActions: ['investigate', 'edit'] as Array<'investigate' | 'edit'>, maxAutoRisk: 'high' as const,
  policyVersion: 'rehearsal', authority: { kind: 'human_approval' as const, approvalRef: 'rehearsal' } };
const proof = await runtime.boundary.attest({ runId, repoKey: 'probe', workspacePath: prepared.path,
  mode: 'write', mandate });
if (!proof) throw new Error(`Write attestation refused; evidence directory: ${root}`);
const runner = createQoderRunner(runtime.launcher, join(root, 'logs'));
let sessionId: string | undefined;
try {
  const started = await runner.start({ taskId: run.taskId, runId, stage: 'develop', mandate,
    repoKey: 'probe', workspace: prepared,
    input: { kind: 'task', runId, sourceEventIds: [], prompt: 'Change only probe.txt from before to after. Commit probe.txt with message "probe change". Do not print environment variables or credentials.' },
    skill: { content: 'Edit only the assigned file in this disposable repository. Commit the change. Do not access other paths or credentials.',
      ref: { repoRef: 'probe', path: 'skills/develop/SKILL.md', commitSha: baseSha, stage: 'develop' } },
    execution: proof, timeoutMs: 180_000 });
  sessionId = started.sessionId;
  const deadline = Date.now() + 180_000;
  let result = await runner.read(sessionId);
  while (result.kind === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    result = await runner.read(sessionId);
  }
  if (result.kind !== 'finished' || result.exitCode !== 0 || !result.resultRef)
    throw new Error(`Qoder did not finish with a verified result; evidence directory: ${root}`);
  const development = await workspace.verifyDevelopment!(activeRun);
  if (readFileSync(join(prepared.path, 'probe.txt'), 'utf8') !== 'after\n')
    throw new Error(`Qoder committed unexpected probe content; evidence directory: ${root}`);
  if (git(prepared.path, 'diff', '--name-only', baseSha, development.commitSha) !== 'probe.txt')
    throw new Error(`Qoder changed files outside the probe; evidence directory: ${root}`);
  const check = runtime.boundary.runCheck!({ proof, command: '/usr/bin/git',
    args: ['diff', '--check', baseSha, development.commitSha], cwd: prepared.path,
    timeoutMs: 10_000, signal: new AbortController().signal });
  const receipt = await check.completion;
  if (receipt.result !== 'passed' || receipt.exitCode !== 0 || !receipt.terminationConfirmed)
    throw new Error(`Isolated Git check did not pass; evidence directory: ${root}`);
  await workspace.verifyAfterChecks!(activeRun, development.commitSha);
  console.log(JSON.stringify({ outcome: 'passed', baseSha, commitSha: development.commitSha,
    diffRef: development.diffRef, checkLogRef: receipt.logRef, resultRef: result.resultRef,
    evidenceDirectory: root }));
} catch (error) {
  if (sessionId) await runner.cancel(sessionId).catch(() => undefined);
  throw error;
} finally {
  await runtime.boundary.release?.(proof);
}
