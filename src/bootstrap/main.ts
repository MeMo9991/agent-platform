import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startConfiguredSchedules } from './start-schedules.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createKernelCoordinator } from '../agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../agent/router/candidate-finder.js';
import { startLocalApi } from '../api/local.js';
import { createWorkerManager } from '../agent/worker/manager.js';
import { createQoderRunner, unavailableQoderLauncher } from '../agent/worker/agents/qoder.js';
import { createMacQoderRuntime } from '../agent/worker/mac-sandbox.js';
import { createGitWorkspaceManager } from '../agent/worker/workspace.js';
import { createGitSkillLoader } from '../skills/git-loader.js';
import { execFileSync } from 'node:child_process';
import { createDevopsAttachmentReader } from '../event/sources/devops/attachment.js';
import { startWorkerLoop } from './worker-loop.js';
import { acquireInstanceLock } from './instance-lock.js';
import { createManualAttachmentReader } from '../event/sources/manual/attachment.js';
import { createRepositorySelector } from './repository-selection.js';
import { createCodeHosts } from '../repository-ci/providers/index.js';
import { createStage5OpenChange } from '../authorization/stage5-open-change.js';
import { autoPrMandate, autoPrRuleRef } from '../authorization/auto-pr.js';
import { randomUUID } from 'node:crypto';
import { authorizationHeaders as defaultAuthorizationHeaders } from './devops-credentials.js';

const databasePath = process.env.AGENT_PLATFORM_DATABASE ?? '.runtime/state/agent-platform.sqlite3';
const instanceLock = await acquireInstanceLock(databasePath, () => {
  console.error('Instance lock was lost; stopping to prevent concurrent dispatch');
  process.exit(1);
});
let stopRuntime: (() => Promise<void>) | undefined;
try {
const authorizationHeaders = process.env.AGENT_PLATFORM_AUTH_PROVIDER
  ? await (async () => {
      const provider: unknown = await import(pathToFileURL(resolve(process.env.AGENT_PLATFORM_AUTH_PROVIDER!)).href);
      const fn = (provider as { authorizationHeaders?: unknown }).authorizationHeaders;
      if (typeof fn !== 'function') throw new Error('Authorization provider must export authorizationHeaders()');
      return fn as () => Promise<HeadersInit>;
    })()
  : defaultAuthorizationHeaders;

const runtime = startConfiguredSchedules({
  platform: process.env.AGENT_PLATFORM_CONFIG ?? 'config/platform.json',
  schedules: process.env.AGENT_PLATFORM_SCHEDULES ?? 'config/schedules.json',
  database: databasePath,
}, authorizationHeaders,
  (taskId, error) => { console.error(`Scheduled task ${taskId} failed`, error); });
stopRuntime = runtime.stop;
const platform = runtime.platform;

const sourceRepoKeys = Object.fromEntries(platform.sources.filter(source => source.projectKey)
  .map(source => [source.id, platform.projectGroups.find(group => group.projectKey === source.projectKey)!.repoKeys]));
const trustedRepoBySource: Record<string, string | readonly string[]> = { ...sourceRepoKeys };
for (const repo of platform.repositories) trustedRepoBySource[`manual:${repo.repoKey}`] = repo.repoKey;
const attachmentReaders = Object.fromEntries(platform.sources.filter(item => item.enabled && item.kind === 'devops-defect')
  .map(item => [item.id, createDevopsAttachmentReader(item.id, authorizationHeaders)]));
const imageDirectory = resolve('.runtime/manual-images');
await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
for (const repo of platform.repositories) attachmentReaders[`manual:${repo.repoKey}`] =
  createManualAttachmentReader(`manual:${repo.repoKey}`, imageDirectory);
const root = process.cwd();
const cloneRoot = resolve(root, '.runtime/clones');
const qoderRuntime = platform.agents.some(agent => agent.kind === 'qoder' && agent.enabled)
  ? await (async () => {
    await mkdir(cloneRoot, { recursive: true, mode: 0o700 });
    return createMacQoderRuntime({ cloneRoot, profileRoot: resolve(root, '.runtime/sandbox-profiles'),
      qoderPath: resolve(homedir(), '.local/bin/qoderclicn'),
      writeEnabled: process.env.AGENT_PLATFORM_QODER_WRITE_ENABLED === '1' });
  })() : undefined;
const runners = { qoder: createQoderRunner(qoderRuntime?.launcher ?? unavailableQoderLauncher,
  resolve(root, '.runtime/logs')) };
const agentKind = platform.agents.find(agent => agent.kind in runners)?.kind;
if (!agentKind) throw new Error('Stage three requires one registered Agent kind');
const stage5WorkerEnabled = process.env.AGENT_PLATFORM_STAGE5_WORKER_ENABLED === '1';
if (stage5WorkerEnabled && !qoderRuntime) throw new Error('Stage five Worker needs an enabled isolated Qoder runtime');
const coordinator = createKernelCoordinator(runtime.store, trustedRepoBySource, platform.policyRef,
  'configured-source', agentKind, platform.repositories.map(repo => repo.repoKey),
  createTaskCandidateFinder(runtime.store), event => {
    const repo = platform.repositories.find(item => item.repoKey === event.repoKey);
    return repo && autoPrMandate(event, repo, platform.policyRef);
  }, sourceRepoKeys);
let routeTimer: ReturnType<typeof setInterval> | undefined;
let ciTimer: ReturnType<typeof setInterval> | undefined;
let ciTick: Promise<void> | undefined;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const skills = createGitSkillLoader({ 'agent-platform': root });
// 临时关闭自定义 Skill：启动时不再预加载 skills/verify、skills/review 的 SKILL.md。
// if (stage5WorkerEnabled) for (const stage of ['verify', 'review'] as const)
//   await skills.load({ repoRef: 'agent-platform', path: `skills/${stage}/SKILL.md`, commitSha: head, stage });
const workspace = createGitWorkspaceManager(Object.fromEntries(platform.repositories.filter(repo => repo.localPath)
  .map(repo => [repo.repoKey, { path: resolve(repo.localPath!),
    remote: `${repo.hostUrl}/${repo.projectRef}.git` }])), resolve(root, '.runtime'),
  run => runtime.store.getTask(run.taskId)?.repoKey ?? '', run => {
    if (!run.commitSha) return undefined;
    const row = runtime.store.db.prepare(`SELECT run_id FROM task_record WHERE task_id=? AND kind='development'
      AND json_extract(payload_json,'$.commitSha')=? AND json_extract(payload_json,'$.postCheckVerified')=1
      ORDER BY at DESC LIMIT 1`).get(run.taskId, run.commitSha);
    const source = row ? runtime.store.getRun(String(row.run_id)) : undefined;
    return source?.stage === 'develop' && source.status === 'succeeded' &&
      source.commitSha === run.commitSha ? source.workspaceRef : undefined;
  });
const codeHosts = createCodeHosts(platform);
const stage5WritesEnabled = process.env.AGENT_PLATFORM_STAGE5_WRITES_ENABLED === '1';
if (stage5WritesEnabled) for (const repo of platform.repositories) {
  const host = codeHosts[repo.repoKey];
  if (!host?.readTarget || !host.readRequiredChecks || !repo.requiredChecks.length)
    throw new Error(`Stage five write preflight is unavailable for ${repo.repoKey}`);
  await host.readTarget(repo.targetBranch);
  await host.readRequiredChecks(repo.targetBranch);
}
const stage5OpenChange = createStage5OpenChange(runtime.store,
  Object.fromEntries(platform.repositories.map(repo => [repo.repoKey, repo])), codeHosts,
  workspace, platform.policyRef);
const manager = createWorkerManager({ store: runtime.store, coordinator,
  runners,
  enabledAgents: platform.agents.filter(agent => agent.enabled).map(agent => agent.kind),
  enabledStages: stage5WorkerEnabled ? ['investigate', 'develop', 'verify', 'review'] : undefined,
  workspace, skills,
  boundary: qoderRuntime?.boundary ?? { async attest() { return undefined; } },
  skillRepoPath: 'agent-platform', skillCommitSha: head,
  riskPolicy: { assess(task) {
    if (task.mandate.authority.kind === 'human_approval') return 'high';
    const repo = platform.repositories.find(item => item.repoKey === task.repoKey);
    return repo && task.mandate.authority.kind === 'auto_pr' &&
      task.mandate.authority.ruleRef === autoPrRuleRef(repo, platform.policyRef) ? 'high' : 'unknown';
  } },
  policyVersion: platform.policyRef,
  localChecks: Object.fromEntries(platform.repositories.map(repo => [repo.repoKey, repo.localChecks])),
  attachmentReaders,
  checkLogDirectory: resolve(root, '.runtime/check-logs'),
  maxRunMs: platform.budget.maxRunMs, limits: platform.budget });
try { await manager.recover(); }
catch (error) { await runtime.stop(); throw error; }
const workerLoop = startWorkerLoop(manager, 1000, error => console.error('Worker loop failed', error));
let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
try {
  api = platform.interaction ? await startLocalApi(runtime.store, coordinator, {
    ...platform.interaction,
    dashboard: { actorId: platform.interaction.actorId,
      repoKeys: platform.repositories.map(repo => repo.repoKey),
      projectGroups: Object.fromEntries(platform.projectGroups.map(group => [group.projectKey,
        { repoKeys: group.repoKeys, defaultRepoKey: group.defaultRepoKey }])),
      selectRepositoryByGroup: Object.fromEntries(platform.projectGroups.map(group =>
        [group.projectKey, createRepositorySelector(group, platform.repositories)])),
      sourceRepoKeys,
      imageDirectory, attachmentReaders, runners,
      evidenceRoot: resolve(root, '.runtime'),
      stage5OpenChange,
      stage5WritesEnabled,
      settingsPaths: { platform: process.env.AGENT_PLATFORM_CONFIG ?? 'config/platform.json',
        schedules: process.env.AGENT_PLATFORM_SCHEDULES ?? 'config/schedules.json' },
      takeoverEvidence: { workspace, boundary: qoderRuntime?.boundary ?? { async attest() { return undefined; } },
        localChecks: Object.fromEntries(platform.repositories.map(repo => [repo.repoKey, repo.localChecks])),
        policyVersion: platform.policyRef },
      workerCapacity: platform.budget.maxConcurrentRuns },
    credentialFile: platform.interaction.credentialFile.startsWith('~/')
      ? resolve(homedir(), platform.interaction.credentialFile.slice(2)) : resolve(platform.interaction.credentialFile),
  }) : undefined;
} catch (error) {
  if (routeTimer) clearInterval(routeTimer);
  await workerLoop.stop();
  await runtime.stop();
  throw error;
}
try { coordinator.processPending(); }
catch (error) { await api?.stop(); await workerLoop.stop(); await runtime.stop(); throw error; }
routeTimer = setInterval(() => {
  try { coordinator.processPending(); } catch (error) { console.error('Event routing failed', error); }
}, 1000);
if (stage5WritesEnabled) {
  const pollCodeHost = () => {
    if (ciTick) return;
    ciTick = (async () => {
      const automatic = runtime.store.db.prepare(`SELECT task.id,task.version FROM task
        WHERE task.state='ready_to_merge' AND json_extract(task.mandate,'$.authority.kind')='auto_pr'
        AND NOT EXISTS (SELECT 1 FROM task_record AS effect WHERE effect.task_id=task.id
          AND effect.kind='effect' AND effect.status='done'
          AND json_extract(effect.payload_json,'$.action')='open_pr')`).all();
      for (const row of automatic) {
        const taskId = String(row.id);
        try {
          const preflight = await stage5OpenChange.prepare(taskId, Number(row.version));
          if (preflight.kind === 'ready') await stage5OpenChange.execute(taskId, Number(row.version));
        } catch (error) {
          console.error(`Automatic PR blocked for Task ${taskId}`, error);
          runtime.store.transaction(() => {
            const current = runtime.store.getTask(taskId);
            const version = Number(runtime.store.db.prepare('SELECT version FROM task WHERE id=?').get(taskId)?.version);
            if (current?.state === 'ready_to_merge' && version === Number(row.version))
              runtime.store.saveTransition(taskId, 'waiting_human', 'Automatic PR preflight failed',
                new Date().toISOString(), randomUUID(), { kind: 'system', id: 'auto-pr' });
          });
        }
      }
      const tasks = runtime.store.db.prepare(`SELECT DISTINCT effect.task_id FROM task_record AS effect
        JOIN task ON task.id=effect.task_id WHERE effect.kind='effect' AND effect.status='done'
        AND json_extract(effect.payload_json,'$.action')='open_pr'
        AND task.state='ready_to_merge'`).all();
      for (const row of tasks) {
        const taskId = String(row.task_id);
        try {
          await stage5OpenChange.status(taskId);
          const pending = runtime.store.db.prepare(`SELECT 1 FROM task_record WHERE task_id=? AND kind='effect'
            AND status IN ('pending','uncertain') AND json_extract(payload_json,'$.action')='merge' LIMIT 1`)
            .get(taskId);
          if (pending) await stage5OpenChange.observeManualMerge(taskId);
        } catch (error) { console.error(`Code-host poll failed for Task ${taskId}`, error); }
      }
    })().catch(error => { console.error('Code-host polling failed', error); })
      .finally(() => { ciTick = undefined; });
  };
  pollCodeHost();
  ciTimer = setInterval(pollCodeHost, 30_000);
}
if (api) console.log(`Local interaction API listening at http://127.0.0.1:${api.port}`);
console.log('Agent platform ready');

let stopping: Promise<void> | undefined;
const stop = () => {
  if (stopping) return;
  if (routeTimer) clearInterval(routeTimer);
  if (ciTimer) clearInterval(ciTimer);
  stopping = (async () => {
    try {
      try { await api?.stop(); }
      finally { try { await workerLoop.stop(); }
        finally { try { await ciTick; } finally { await runtime.stop(); } } }
    }
    finally { await instanceLock.release(); }
  })()
    .catch(error => { console.error('Shutdown failed', error); process.exitCode = 1; });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
} catch (error) {
  try { await stopRuntime?.(); } finally { await instanceLock.release(); }
  throw error;
}
