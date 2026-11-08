import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { ExecutionBoundary } from './manager.js';
import type { IsolatedProcessLauncher } from './agents/qoder.js';

export async function createMacSandboxProfile(input: { workspacePath: string; temporaryPath: string;
  qoderConfigPath: string; qoderLinkDirectory: string; homePath: string; mode: 'read' | 'write' }) {
  const [workspace, temporary, qoderConfig, qoderLink, home] = await Promise.all([
    input.workspacePath, input.temporaryPath, input.qoderConfigPath, input.qoderLinkDirectory, input.homePath,
  ].map(path => realpath(resolve(path))));
  if (workspace === home || temporary === home || workspace === temporary ||
      workspace.startsWith(`${qoderConfig}/`) || temporary.startsWith(`${qoderConfig}/`) ||
      qoderConfig.startsWith(`${workspace}/`) || qoderLink.startsWith(`${workspace}/`))
    throw new Error('Mac sandbox paths overlap protected runtime directories');
  const quoted = (path: string) => JSON.stringify(path);
  const except = (paths: string[]) => paths.map(path => `(require-not (subpath ${quoted(path)}))`).join(' ');
  const exceptMetadata = (paths: string[]) => {
    const parents = new Set<string>();
    for (const path of paths) for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent))
      parents.add(parent);
    return `${except(paths)} ${[...parents].map(path => `(require-not (literal ${quoted(path)}))`).join(' ')}`;
  };
  const homeReads = [qoderConfig, qoderLink, workspace, temporary];
  const tmpReads = [qoderConfig, qoderLink, workspace, temporary];
  // shortcut: Qoder's own account state remains accessible; use a dedicated OS account when that credential must be isolated from the Agent.
  const profile = [
    '(version 1)', '(allow default)',
    `(deny file-read-data (require-all (subpath ${quoted(home)}) ${except(homeReads)}))`,
    `(deny file-read-metadata (require-all (subpath ${quoted(home)}) ${exceptMetadata(homeReads)}))`,
    `(deny file-read-data (require-all (subpath "/private/tmp") ${except(tmpReads)}))`,
    `(deny file-read-metadata (require-all (subpath "/private/tmp") ${exceptMetadata(tmpReads)}))`,
    `(deny file-write* (require-all ${except([
      qoderConfig, temporary, ...(input.mode === 'write' ? [workspace] : []),
    ])} (require-not (literal "/dev/null"))))`,
  ].join('\n') + '\n';
  return { profile, digest: createHash('sha256').update(profile).digest('hex') };
}

export async function createMacQoderRuntime(input: { cloneRoot: string; profileRoot: string;
  qoderPath: string }): Promise<{ boundary: ExecutionBoundary; launcher: IsolatedProcessLauncher }> {
  if (process.platform !== 'darwin') throw new Error('Qoder sandbox requires macOS');
  const home = await realpath(homedir());
  const cloneRoot = await realpath(input.cloneRoot);
  const qoder = await realpath(input.qoderPath);
  const qoderLink = await realpath(dirname(input.qoderPath));
  const qoderConfig = await realpath(resolve(home, '.qoder-cn'));
  let vpcArgs: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(resolve(qoderConfig, 'settings.json'), 'utf8')) as Record<string, unknown>;
    if (settings.vpcInstanceName !== undefined) {
      if (typeof settings.vpcInstanceName !== 'string' ||
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(settings.vpcInstanceName))
        throw new Error('Invalid QoderCN VPC instance name');
      vpcArgs = ['--settings', JSON.stringify({ vpcInstanceName: settings.vpcInstanceName })];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await lstat('/usr/bin/sandbox-exec');
  await mkdir(input.profileRoot, { recursive: true, mode: 0o700 });
  const profileRoot = await realpath(input.profileRoot);
  const proofs = new Map<string, { repoKey: string; workspace: string; temporary: string;
    profilePath: string; checkProfilePath: string; digest: string; checkDigest: string;
    mode: 'read' | 'write'; launched: boolean;
    agentClosed: boolean; checking: boolean }>();
  const matchProof = (proof: { verified: true; runId: string; repoKey: string; workspacePath: string;
    mode: 'read' | 'write'; adapterVersion: string; configDigest: string }, cwd: string) => {
    const saved = proofs.get(proof.runId);
    if (!saved || proof.verified !== true || proof.adapterVersion !== 'mac-sandbox-1' || saved.repoKey !== proof.repoKey ||
        saved.workspace !== cwd || proof.workspacePath !== cwd || saved.mode !== proof.mode ||
        saved.digest !== proof.configDigest ||
        createHash('sha256').update(readFileSync(saved.profilePath)).digest('hex') !== saved.digest)
      throw new Error('Process does not match verified isolation');
    return saved;
  };
  const groupGone = (pid: number | undefined) => {
    if (!pid) return false;
    try { process.kill(-pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  const boundary: ExecutionBoundary = { async attest({ runId, repoKey, workspacePath, mode }) {
    if (mode !== 'read' || !/^[A-Za-z0-9_-]+$/.test(runId)) return undefined;
    if (proofs.has(runId)) throw new Error('Previous Run isolation is still active');
    const workspace = await realpath(workspacePath);
    if (workspace !== resolve(cloneRoot, runId) || !(await lstat(resolve(workspace, '.git'))).isDirectory())
      throw new Error('Qoder workspace is not an independent Run clone');
    const temporary = await mkdtemp('/private/tmp/agent-platform-qoder-');
    const { profile, digest } = await createMacSandboxProfile({ workspacePath: workspace,
      temporaryPath: temporary, qoderConfigPath: qoderConfig, qoderLinkDirectory: qoderLink,
      homePath: home, mode });
    // shortcut: a crashed process may leave its old profile; persist profile paths before automatic crash cleanup.
    const profilePath = resolve(profileRoot, `${runId}-${randomUUID()}.sb`);
    const checkProfilePath = resolve(profileRoot, `${runId}-${randomUUID()}-check.sb`);
    const checkProfile = `${profile}(deny file-read* (subpath ${JSON.stringify(qoderConfig)}))\n`;
    const checkDigest = createHash('sha256').update(checkProfile).digest('hex');
    await writeFile(profilePath, profile, { mode: 0o600, flag: 'wx' });
    try { await writeFile(checkProfilePath, checkProfile, { mode: 0o600, flag: 'wx' }); }
    catch (error) { await rm(profilePath, { force: true }); await rm(temporary, { recursive: true, force: true }); throw error; }
    proofs.set(runId, { repoKey, workspace, temporary, profilePath, checkProfilePath, digest, checkDigest, mode,
      launched: false, agentClosed: false, checking: false });
    return { verified: true, runId, repoKey, workspacePath: workspace,
      mode, adapterVersion: 'mac-sandbox-1', configDigest: digest };
  }, runCheck({ proof, command, args, cwd }) {
    const saved = matchProof(proof, proof.workspacePath);
    if (cwd !== saved.workspace && !cwd.startsWith(`${saved.temporary}/`))
      throw new Error('Isolated check directory is outside the Run');
    if (createHash('sha256').update(readFileSync(saved.checkProfilePath)).digest('hex') !== saved.checkDigest)
      throw new Error('Trusted-check profile changed');
    if (!saved.launched || !saved.agentClosed || saved.checking || !command || command.includes('\0') ||
        args.some(arg => arg.includes('\0')))
      throw new Error('Isolated check is not ready');
    saved.checking = true;
    const logRef = resolve(profileRoot, `${proof.runId}-check-${randomUUID()}.log`);
    const child = spawn('/usr/bin/sandbox-exec', ['-f', saved.checkProfilePath, command, ...args], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: saved.temporary, USER: process.env.USER ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8',
        PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        TMPDIR: saved.temporary, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    let output = '';
    let exited = false;
    let exitCode: number | null = null;
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(0, 10 * 1024 * 1024); });
    child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(0, 10 * 1024 * 1024); });
    const completion = new Promise<{ result: 'passed' | 'failed' | 'timeout' | 'unavailable';
      exitCode: number | null; logRef: string; terminationConfirmed: boolean }>((resolve, reject) => {
      child.once('error', error => { output += `\n${String(error)}`; });
      child.once('close', async code => {
        exited = true;
        exitCode = code;
        saved.checking = false;
        try { await writeFile(logRef, output, { mode: 0o600, flag: 'wx' }); }
        catch (error) { reject(error); return; }
        resolve({ result: code === null ? 'unavailable' : code === 0 ? 'passed' : 'failed',
          exitCode: code, logRef, terminationConfirmed: groupGone(child.pid) });
      });
    });
    return { completion, async terminate() {
      if (!exited && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* inspect close below */ }
      }
      const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2500));
      await Promise.race([completion, timeout]);
      if (!exited && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* inspect close below */ }
        await Promise.race([completion, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1500))]);
      }
      return { terminated: exited && groupGone(child.pid), logRef: exited ? logRef : undefined };
    } };
  }, async prepareDependencies({ proof, cwd }) {
    const saved = matchProof(proof, cwd);
    if (!saved.launched || !saved.agentClosed || saved.checking)
      throw new Error('Dependency preparation is not ready');
    const installRoot = resolve(saved.temporary, 'dependency-install');
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    const manifestPaths = ['package.json', 'package-lock.json'];
    try { if ((await lstat(resolve(cwd, 'web/package.json'))).isFile()) manifestPaths.push('web/package.json'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (manifestPaths.length === 3) await mkdir(resolve(installRoot, 'web'), { recursive: true, mode: 0o700 });
    for (const path of manifestPaths) {
      if (!(await lstat(resolve(cwd, path))).isFile()) throw new Error('Dependency manifest is not a regular file');
      await copyFile(resolve(cwd, path), resolve(installRoot, path));
    }
    const destination = resolve(cwd, 'node_modules');
    try { await lstat(destination); throw new Error('Run dependency path already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund',
      '--cache', resolve(saved.temporary, 'npm-cache')];
    const timeoutMs = 180_000;
    const startedAt = new Date().toISOString();
    const handle = boundary.runCheck!({ proof, command: 'npm', args, cwd: installRoot,
      timeoutMs, signal: new AbortController().signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([handle.completion, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    })]);
    if (timer) clearTimeout(timer);
    const stopped = receipt ? undefined : await handle.terminate();
    const result = receipt ?? { result: stopped?.terminated ? 'timeout' as const : 'unavailable' as const,
      exitCode: null, logRef: stopped?.logRef ?? '', terminationConfirmed: stopped?.terminated === true };
    if (result.result === 'passed' && result.terminationConfirmed && result.exitCode === 0) {
      await mkdir(resolve(installRoot, 'node_modules'), { recursive: true, mode: 0o700 });
      if (!(await lstat(resolve(installRoot, 'node_modules'))).isDirectory())
        throw new Error('npm ci produced no dependency directory');
      await symlink(resolve(installRoot, 'node_modules'), destination, 'dir');
      await writeFile(resolve(cwd, '.git/info/exclude'), '\n/node_modules\n', { flag: 'a' });
    }
    return { command: 'npm', args, timeoutMs, startedAt, endedAt: new Date().toISOString(), ...result };
  }, async release(proof) {
    if (!proofs.has(proof.runId)) return;
    const saved = matchProof(proof, proof.workspacePath);
    if (saved.checking || (saved.launched && !saved.agentClosed)) throw new Error('Cannot release active isolation');
    proofs.delete(proof.runId);
    await rm(saved.profilePath, { force: true });
    await rm(saved.checkProfilePath, { force: true });
    await rm(saved.temporary, { recursive: true, force: true });
  } };
  const launcher: IsolatedProcessLauncher = { verified: true, launch(command, args, cwd, proof) {
    if (command !== 'qoderclicn' || proof.verified !== true || proof.mode !== 'read')
      throw new Error('Qoder launch does not match verified isolation');
    const saved = matchProof(proof, cwd);
    if (saved.launched) throw new Error('Qoder Run already launched');
    saved.launched = true;
    const child = spawn('/usr/bin/sandbox-exec', ['-f', saved.profilePath, qoder, ...vpcArgs, ...args], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, USER: process.env.USER ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8',
        PATH: qoderLink + ':/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: saved.temporary,
        ...(process.env.QODERCN_PERSONAL_ACCESS_TOKEN
          ? { QODERCN_PERSONAL_ACCESS_TOKEN: process.env.QODERCN_PERSONAL_ACCESS_TOKEN } : {}) },
    });
    child.once('close', () => { saved.agentClosed = groupGone(child.pid); });
    return { process: child, isTerminated() { return groupGone(child.pid); }, terminate() {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 'SIGTERM'); return true; }
      catch { return false; }
    } };
  } };
  return { boundary, launcher };
}
