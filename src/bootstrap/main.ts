import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startConfiguredSchedules } from './start-schedules.js';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { platformConfig } from './config.js';
import { createKernelCoordinator } from '../agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../agent/router/candidate-finder.js';
import { startLocalApi } from '../api/local.js';
import { createWorkerManager } from '../agent/worker/manager.js';
import { createQoderRunner, unavailableQoderLauncher } from '../agent/worker/agents/qoder.js';
import { createMacQoderRuntime } from '../agent/worker/mac-sandbox.js';
import { createGitWorkspaceManager } from '../agent/worker/workspace.js';
import { createGitSkillLoader } from '../skills/git-loader.js';
import { execFileSync } from 'node:child_process';
import { loadScheduleConfig } from './scheduler.js';
import { devopsDefectParameters } from './devops-task.js';
import { createDevopsAttachmentReader } from '../event/sources/devops/attachment.js';
import { startWorkerLoop } from './worker-loop.js';
import { acquireInstanceLock } from './instance-lock.js';
import { createManualAttachmentReader } from '../event/sources/manual/attachment.js';

const platform = platformConfig.parse(JSON.parse(readFileSync(process.env.AGENT_PLATFORM_CONFIG ?? 'config/platform.json', 'utf8')));
const databasePath = process.env.AGENT_PLATFORM_DATABASE ?? '.runtime/state/agent-platform.sqlite3';
const instanceLock = await acquireInstanceLock(databasePath, () => {
  console.error('Instance lock was lost; stopping to prevent concurrent dispatch');
  process.exit(1);
});
let stopRuntime: (() => Promise<void>) | undefined;
try {
const providerPath = process.env.AGENT_PLATFORM_AUTH_PROVIDER;
if (!providerPath) throw new Error('AGENT_PLATFORM_AUTH_PROVIDER must name a trusted authorization provider module');
const provider: unknown = await import(pathToFileURL(resolve(providerPath)).href);
const authorizationHeaders = (provider as { authorizationHeaders?: unknown }).authorizationHeaders;
if (typeof authorizationHeaders !== 'function') throw new Error('Authorization provider must export authorizationHeaders()');

const runtime = startConfiguredSchedules({
  platform: process.env.AGENT_PLATFORM_CONFIG ?? 'config/platform.json',
  schedules: process.env.AGENT_PLATFORM_SCHEDULES ?? 'config/schedules.json',
  database: databasePath,
}, authorizationHeaders as () => Promise<HeadersInit>,
  (taskId, error) => { console.error(`Scheduled task ${taskId} failed`, error); });
stopRuntime = runtime.stop;

const schedule = loadScheduleConfig(process.env.AGENT_PLATFORM_SCHEDULES ?? 'config/schedules.json');
const trustedRepoBySource = Object.fromEntries(schedule.tasks.filter(item => item.enabled && item.kind === 'devops-defect-poll')
  .map(item => devopsDefectParameters.parse(item.parameters)).filter(item => item.repoKey)
  .map(item => [item.sourceId, item.repoKey!]));
for (const repo of platform.repositories) trustedRepoBySource[`manual:${repo.repoKey}`] = repo.repoKey;
const attachmentReaders = Object.fromEntries(schedule.tasks.filter(item => item.enabled && item.kind === 'devops-defect-poll')
  .map(item => devopsDefectParameters.parse(item.parameters))
  .map(item => [item.sourceId, createDevopsAttachmentReader(item.sourceId,
    authorizationHeaders as () => Promise<HeadersInit>)]));
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
      qoderPath: resolve(homedir(), '.local/bin/qoderclicn') });
  })() : undefined;
const runners = { qoder: createQoderRunner(qoderRuntime?.launcher ?? unavailableQoderLauncher,
  resolve(root, '.runtime/logs')) };
const agentKind = platform.agents.find(agent => agent.kind in runners)?.kind;
if (!agentKind) throw new Error('Stage three requires one registered Agent kind');
const coordinator = createKernelCoordinator(runtime.store, trustedRepoBySource, platform.policyRef,
  'configured-source', agentKind, platform.repositories.map(repo => repo.repoKey),
  createTaskCandidateFinder(runtime.store));
let routeTimer: ReturnType<typeof setInterval> | undefined;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const workspace = createGitWorkspaceManager(Object.fromEntries(platform.repositories.filter(repo => repo.localPath)
  .map(repo => [repo.repoKey, { path: resolve(repo.localPath!),
    remote: `${repo.hostUrl}/${repo.projectRef}.git` }])), resolve(root, '.runtime'),
  run => runtime.store.getTask(run.taskId)?.repoKey ?? '');
const manager = createWorkerManager({ store: runtime.store, coordinator,
  runners,
  enabledAgents: platform.agents.filter(agent => agent.enabled).map(agent => agent.kind),
  workspace, skills: createGitSkillLoader({ 'agent-platform': root }),
  boundary: qoderRuntime?.boundary ?? { async attest() { return undefined; } },
  skillRepoPath: 'agent-platform', skillCommitSha: head,
  riskPolicy: { assess() { return 'unknown'; } }, policyVersion: platform.policyRef,
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
      repoKeys: platform.repositories.map(repo => repo.repoKey), imageDirectory, attachmentReaders, runners,
      evidenceRoot: resolve(root, '.runtime'),
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
if (api) console.log(`Local interaction API listening at http://127.0.0.1:${api.port}`);
console.log('Agent platform ready');

let stopping: Promise<void> | undefined;
const stop = () => {
  if (stopping) return;
  if (routeTimer) clearInterval(routeTimer);
  stopping = (async () => {
    try {
      try { await api?.stop(); }
      finally { try { await workerLoop.stop(); } finally { await runtime.stop(); } }
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
