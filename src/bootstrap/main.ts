import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScheduledRuntime } from './schedules/start-schedules.js';
import { loadConfiguration } from './config/load.js';
import { previewConfigMigration } from './config/migrate.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createKernelCoordinator } from '../agent/kernel/coordinator.js';
import { createTaskCandidateFinder } from '../agent/router/candidate-finder.js';
import { startLocalApi } from '../api/local.js';
import { createWorkerManager } from '../agent/worker/manager.js';
import type { Run } from '../agent/worker/model.js';
import { createQoderRunner, unavailableQoderLauncher } from '../agent/worker/agents/qoder.js';
import { createMacQoderRuntime } from '../agent/worker/mac-sandbox.js';
import { createGitWorkspaceManager } from '../agent/worker/workspace.js';
import { createGitSkillLoader } from '../skills/git-loader.js';
import { execFileSync } from 'node:child_process';
import { createDevopsAttachmentReader } from '../event/sources/devops/attachment.js';
import { startWorkerLoop } from './runtime/worker-loop.js';
import { runStartupTasks } from './runtime/startup-tasks.js';
import { acquireInstanceLock } from './runtime/instance-lock.js';
import { createManualAttachmentReader } from '../event/sources/manual/attachment.js';
import { createRepositorySelector } from './config/repository-selection.js';
import { createCodeHosts } from '../repository-ci/providers/index.js';
import { createStage5OpenChange } from '../authorization/stage5-open-change.js';
import { resolveReview } from '../authorization/policy/config.js';
import { createPolicyAuditSink, decide, setPolicyAuditSink } from '../authorization/policy/evaluate.js';
import { autoPrMandate, autoPrRuleRef } from '../authorization/auto-pr.js';
import { scheduledMrApprovalCandidates } from '../authorization/scheduled-mr-approval.js';
import { randomUUID } from 'node:crypto';
import { authorizationHeaders as defaultAuthorizationHeaders } from './credentials/devops-credentials.js';
import { configuredGroupVerifier, configuredLocalVerification, stage5PreflightRepositories } from './config/config.js';
import type { GroupWorkspaceConfig } from '../agent/worker/workspace.js';
import type { GroupVerifier } from '../agent/worker/group-verifiers.js';

const root = process.cwd();
const config = loadConfiguration(root);
const { runtimeRoot, database, capabilities, authProvider } = config;
const check = process.argv[2];
if (check === '--migrate-preview') {
  const result = previewConfigMigration(root, config);
  if (result.ignored.length) console.error(`Ignored legacy fields: ${result.ignored.join(', ')}`);
  if (result.requiredEnvironment.length)
    console.error(`Keep credential environment variables where used: ${result.requiredEnvironment.join(', ')}`);
  process.stdout.write(result.yaml);
  process.exit(0);
}
if (check === '--check' || check === '--port') {
  const port = config.platform.interaction?.port;
  console.log(check === '--port' ? port ?? '' : JSON.stringify({
    configuration: config.paths, runtimeRoot, database, port, capabilities,
  }, null, 2));
  process.exit(0);
}
for (const [key, value] of Object.entries(config.env))
  if (value !== undefined) process.env[key] = value;
if (config.javaHome) process.env.JAVA_HOME = config.javaHome;
if (config.mavenSettings) process.env.MAVEN_SETTINGS = config.mavenSettings;
setPolicyAuditSink(createPolicyAuditSink(runtimeRoot));
const instanceLock = await acquireInstanceLock(database, () => {
  console.error('Instance lock was lost; stopping to prevent concurrent dispatch');
  process.exit(1);
});
let stopRuntime: (() => Promise<void>) | undefined;
try {
const authorizationHeaders = authProvider
  ? await (async () => {
      const provider: unknown = await import(pathToFileURL(authProvider).href);
      const fn = (provider as { authorizationHeaders?: unknown }).authorizationHeaders;
      if (typeof fn !== 'function') throw new Error('Authorization provider must export authorizationHeaders()');
      return fn as () => Promise<HeadersInit>;
    })()
  : defaultAuthorizationHeaders;

const runtime = createScheduledRuntime(database, config.platform, config.schedules, authorizationHeaders,
  (taskId, error) => { console.error(`Scheduled task ${taskId} failed`, error); });
stopRuntime = runtime.stop;
const platform = runtime.platform;

const reviewPolicy = resolveReview(platform.review, platform.policyRef);
const sourceRepoKeys = Object.fromEntries(platform.sources.filter(source => source.projectKey)
  .map(source => [source.id, platform.projectGroups.find(group => group.projectKey === source.projectKey)!.repoKeys]));
const trustedRepoBySource: Record<string, string | readonly string[]> = { ...sourceRepoKeys };
for (const repo of platform.repositories) trustedRepoBySource[`manual:${repo.repoKey}`] = repo.repoKey;
const attachmentReaders = Object.fromEntries(platform.sources.filter(item => item.enabled && item.kind === 'devops-defect')
  .map(item => [item.id, createDevopsAttachmentReader(item.id, authorizationHeaders)]));
const imageDirectory = resolve(runtimeRoot, 'manual-images');
await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
for (const repo of platform.repositories) attachmentReaders[`manual:${repo.repoKey}`] =
  createManualAttachmentReader(`manual:${repo.repoKey}`, imageDirectory);
const qoderPath = resolve(homedir(), '.local/bin/qoderclicn');
const cloneRoot = resolve(runtimeRoot, 'clones');
const cacheRoot = platform.cache?.root ? resolve(root, platform.cache.root) : resolve(runtimeRoot, 'caches');
const qoderAgent = platform.agents.find(agent => agent.kind === 'qoder' && agent.enabled);
const qoderRuntime = qoderAgent
  ? await (async () => {
    await mkdir(cloneRoot, { recursive: true, mode: 0o700 });
    return createMacQoderRuntime({ cloneRoot, profileRoot: resolve(runtimeRoot, 'sandbox-profiles'),
      qoderPath,
      writeEnabled: capabilities.qoderWrite });
  })() : undefined;
const runners = { qoder: createQoderRunner(qoderRuntime?.launcher ?? unavailableQoderLauncher,
  resolve(runtimeRoot, 'logs'), qoderAgent?.model) };
const agentKind = 'qoder';
const stage5WorkerEnabled = capabilities.stage5Worker;
const codeHosts = createCodeHosts(platform);
const stage5WritableRepos = new Set<string>();
if (capabilities.stage5Writes) {
  let checkingRepo: string | undefined;
  try {
    const repositories = stage5PreflightRepositories(platform);
    for (const repo of repositories) {
      checkingRepo = repo.repoKey;
      const host = codeHosts[repo.repoKey];
      if (!host?.readTarget || !host.readRequiredChecks) throw new Error('Code-host preflight is unavailable');
      await host.readTarget(repo.targetBranch);
      await host.readRequiredChecks(repo.targetBranch);
    }
    for (const repo of repositories) stage5WritableRepos.add(repo.repoKey);
  } catch (error) {
    console.warn(`External code-host writes disabled: startup preflight failed${checkingRepo ? ` for ${checkingRepo}` : ''}`, error);
  }
}
const stage5WritesEnabled = stage5WritableRepos.size > 0;
if (stage5WorkerEnabled && !qoderRuntime) throw new Error('Stage five Worker needs an enabled isolated Qoder runtime');
const groupVerifications: Record<string, GroupWorkspaceConfig> = Object.create(null);
const repoGroupVerifiers: Record<string, GroupVerifier> = Object.create(null);
for (const group of platform.projectGroups) {
  const verifier = stage5WorkerEnabled ? configuredGroupVerifier(group) : undefined;
  if (group.functionalVerificationUrl && !verifier)
    throw new Error(`Functional verification for ${group.projectKey} requires an enabled, ready group verifier`);
  if (!verifier) {
    if (config.local && group.verification && stage5WorkerEnabled)
      throw new Error(`Verification for ${group.projectKey} requires accessible localPath entries and Maven buildFile if configured`);
    continue;
  }
  for (const repoKey of group.repoKeys) repoGroupVerifiers[repoKey] = verifier;
  if (verifier.buildFile) {
    const workspaceConfig = { projectKey: group.projectKey, searchRoot: group.searchRoot!,
      moduleSelection: verifier.moduleSelection, buildFile: verifier.buildFile,
      repositories: Object.fromEntries(group.repositories.map(repo =>
        [repo.repoKey, { path: resolve(repo.localPath!), remote: `${repo.hostUrl}/${repo.projectRef}.git` }])) };
    for (const repoKey of group.repoKeys) groupVerifications[repoKey] = workspaceConfig;
  }
}
const groupChecks: Record<string, GroupVerifier['checks']> = Object.create(null);
for (const [repoKey, verifier] of Object.entries(repoGroupVerifiers)) groupChecks[repoKey] = verifier.checks;
const functionalVerificationUrls = Object.fromEntries(platform.projectGroups.filter(group =>
  group.functionalVerificationUrl)
  .flatMap(group => group.repoKeys.map(repoKey => [repoKey, group.functionalVerificationUrl!] as const)));
const investigationApprovalSources = new Set(config.schedules.tasks.map(task => task.id));
const scheduledDefectSources = new Set(config.schedules.tasks.filter(task =>
  task.enabled && task.kind === 'devops-defect-poll').map(task => task.id));
const coordinator = createKernelCoordinator(runtime.store, trustedRepoBySource, platform.policyRef,
  'configured-source', agentKind, platform.repositories.map(repo => repo.repoKey),
  createTaskCandidateFinder(runtime.store), event => {
    const repo = platform.repositories.find(item => item.repoKey === event.repoKey);
    if (!repo) return undefined;
    const policy = decide({ gate: 'intake', repoKey: repo.repoKey }, reviewPolicy);
    if (policy?.enforced && policy.decision.effect !== 'allow') return undefined;
    return autoPrMandate(event, repo, platform.policyRef);
  }, sourceRepoKeys, reviewPolicy, repoKey =>
    Boolean(groupChecks[repoKey] || (!platform.projectGroups.some(group => group.repoKeys.includes(repoKey)) &&
      platform.repositories.find(repo => repo.repoKey === repoKey &&
      configuredLocalVerification(repo, stage5WorkerEnabled)))), repoKey =>
    Boolean(!platform.projectGroups.some(group => group.repoKeys.includes(repoKey)) &&
      platform.repositories.find(repo => repo.repoKey === repoKey && repo.localChecks.length > 0)),
  repoKey => stage5WritableRepos.has(repoKey), repoKey => Boolean(functionalVerificationUrls[repoKey]),
  investigationApprovalSources);
for (const row of runtime.store.db.prepare(`SELECT run.id, task.repo_key AS repoKey,
    (SELECT json_extract(record.payload_json,'$.summary') FROM task_record AS record
      WHERE record.run_id=run.id AND record.kind='agent_report' AND record.status='failed'
      ORDER BY record.at DESC,record.id DESC LIMIT 1) AS reason
    FROM run JOIN task ON task.id=run.task_id
    WHERE run.stage='functional_verify' AND run.status IN ('paused','failed')
      AND task.state IN ('blocked','failed','paused','waiting_human')
      AND run.id=(SELECT id FROM run AS latest WHERE latest.task_id=task.id
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)`).all()) {
  if (functionalVerificationUrls[String(row.repoKey)])
    coordinator.offerFunctionalReview(String(row.id), String(row.reason ?? 'Functional verification stopped without a valid result'));
}
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
    remote: `${repo.hostUrl}/${repo.projectRef}.git` }])), runtimeRoot,
  run => runtime.store.getTask(run.taskId)?.repoKey ?? '', run => {
    if (!run.commitSha) return undefined;
    const row = runtime.store.db.prepare(`SELECT run_id FROM task_record WHERE task_id=? AND kind='development'
      AND json_extract(payload_json,'$.commitSha')=? AND json_extract(payload_json,'$.postCheckVerified')=1
      ORDER BY at DESC LIMIT 1`).get(run.taskId, run.commitSha);
    const source = row ? runtime.store.getRun(String(row.run_id)) : undefined;
    return source?.stage === 'develop' && source.status === 'succeeded' &&
      source.commitSha === run.commitSha ? source.workspaceRef : undefined;
  }, run => {
    const row = runtime.store.db.prepare(`SELECT workspace_ref FROM run WHERE task_id=? AND iteration=?
      AND stage='investigate' AND status='succeeded' AND workspace_ref IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1`).get(run.taskId, run.iteration);
    return row?.workspace_ref ? String(row.workspace_ref) : undefined;
  }, run => runtime.store.getTask(run.taskId)?.baseRef, groupVerifications);
const stage5OpenChange = createStage5OpenChange(runtime.store,
  Object.fromEntries(platform.repositories.map(repo => [repo.repoKey, repo])), codeHosts,
  workspace, platform.policyRef, undefined, reviewPolicy);
const platformVerifyEnabled = platform.repositories.some(repo => repo.verify?.mode === 'platform') ||
  Object.keys(groupChecks).length > 0;
const enabledStages: readonly Run['stage'][] | undefined = stage5WorkerEnabled
  ? ['investigate', 'develop', 'verify', 'functional_verify', 'review']
  : platformVerifyEnabled ? ['investigate', 'develop', 'verify'] : undefined;
const manager = createWorkerManager({ store: runtime.store, coordinator,
  runners,
  enabledAgents: platform.agents.filter(agent => agent.enabled).map(agent => agent.kind),
  enabledStages,
  workspace, skills,
  boundary: qoderRuntime?.boundary ?? { async attest() { return undefined; } },
  skillRepoPath: 'agent-platform', skillCommitSha: head,
  riskPolicy: { assess(task) {
    if (task.mandate.authority.kind === 'human_approval') return 'high';
    const repo = platform.repositories.find(item => item.repoKey === task.repoKey);
    return repo && task.mandate.authority.kind === 'auto_pr' &&
      task.mandate.authority.ruleRef === autoPrRuleRef(repo, platform.policyRef) ? 'high' : 'unknown';
  } },
  policyVersion: platform.policyRef, reviewPolicy,
  localChecks: Object.fromEntries(platform.repositories.map(repo => [repo.repoKey, repo.localChecks])),
  groupChecks,
  functionalVerificationUrls,
  groupSnapshotRepos: new Set(Object.keys(groupVerifications)),
  verifyPlans: Object.fromEntries(platform.repositories.map(repo =>
    [repo.repoKey, repoGroupVerifiers[repo.repoKey]?.verify ?? repo.verify])),
  cacheRoot, agentVerifyEnabled: stage5WorkerEnabled,
  attachmentReaders,
  checkLogDirectory: resolve(runtimeRoot, 'check-logs'),
  maxRunMs: platform.budget.maxRunMs, limits: platform.budget });
try { await manager.recover(); }
catch (error) { await runtime.stop(); throw error; }
const startup = await runStartupTasks({ platform, store: runtime.store, runtimeRoot,
  qoderPath, retentionMs: config.workspaceRetentionMs, orphanGraceMs: config.workspaceOrphanGraceMs,
  onError: (task, error) => console.error(`Startup task ${task} failed`, error) });
if (startup.prune && (startup.prune.clonesDeleted || startup.prune.checkWorkspacesDeleted))
  console.log(`Pruned ${startup.prune.clonesDeleted} Run clones and ${startup.prune.checkWorkspacesDeleted} check workspaces`);
for (const agent of startup.agents) if (!agent.linked)
  console.warn(`Agent ${agent.kind} is not linked: ${agent.detail}`);
const agentLinks = startup.agents;
const workerLoop = startWorkerLoop(manager, 1000, error => console.error('Worker loop failed', error));
let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
try {
  api = platform.interaction ? await startLocalApi(runtime.store, coordinator, {
    ...platform.interaction,
    dashboard: { actorId: platform.interaction.actorId,
      repoKeys: platform.repositories.map(repo => repo.repoKey),
      unverifiedRepoKeys: platform.repositories.filter(repo => !groupChecks[repo.repoKey] &&
        !configuredLocalVerification(repo, stage5WorkerEnabled))
        .map(repo => repo.repoKey),
      projectGroups: Object.fromEntries(platform.projectGroups.map(group => [group.projectKey,
        { repoKeys: group.repoKeys, defaultRepoKey: group.defaultRepoKey }])),
      selectRepositoryByGroup: Object.fromEntries(platform.projectGroups.map(group =>
        [group.projectKey, createRepositorySelector(group, platform.repositories)])),
      sourceRepoKeys,
      imageDirectory, attachmentReaders, runners,
      evidenceRoot: runtimeRoot,
      stage5OpenChange,
      stage5WritesEnabled,
      agentLinks,
      investigationApprovalSources,
      settingsPaths: config.paths,
      settingsSnapshot: { platform: config.platform, schedules: config.schedules, revision: config.revision,
        capabilities: { stage5Worker: stage5WorkerEnabled, qoderWrite: Boolean(qoderRuntime && capabilities.qoderWrite),
          stage5Writes: stage5WritesEnabled } },
      externalDevopsAuth: Boolean(authProvider),
      manualCloneRoot: relative(root, cloneRoot),
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
try { coordinator.processPending(); runtime.start(); }
catch (error) { await api?.stop(); await workerLoop.stop(); await runtime.stop(); throw error; }
routeTimer = setInterval(() => {
  try { coordinator.processPending(); } catch (error) { console.error('Event routing failed', error); }
}, 1000);
if (stage5WritesEnabled) {
  const pollCodeHost = () => {
    if (ciTick) return;
    ciTick = (async () => {
      const automatic = runtime.store.db.prepare(`SELECT task.id,task.version,task.repo_key FROM task
        WHERE task.state='ready_to_merge' AND json_extract(task.mandate,'$.authority.kind')='auto_pr'
        AND NOT EXISTS (SELECT 1 FROM task_record AS effect WHERE effect.task_id=task.id
          AND effect.kind='effect' AND effect.status='done'
          AND json_extract(effect.payload_json,'$.action')='open_pr')`).all();
      for (const row of automatic) {
        if (!stage5WritableRepos.has(String(row.repo_key))) continue;
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
      for (const { taskId, version } of scheduledMrApprovalCandidates(runtime.store, platform.repositories,
        scheduledDefectSources, stage5WritableRepos)) {
        try {
          const preflight = await stage5OpenChange.prepare(taskId, version);
          if (preflight.kind === 'ready') await stage5OpenChange.execute(taskId, version);
        } catch (error) { console.error(`Scheduled MR delivery failed for Task ${taskId}`, error); }
      }
      const tasks = runtime.store.db.prepare(`SELECT DISTINCT effect.task_id,task.repo_key FROM task_record AS effect
        JOIN task ON task.id=effect.task_id WHERE effect.kind='effect' AND effect.status='done'
        AND json_extract(effect.payload_json,'$.action')='open_pr'
        AND task.state='ready_to_merge'`).all();
      for (const row of tasks) {
        if (!stage5WritableRepos.has(String(row.repo_key))) continue;
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
