import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Run, WorkspaceManager } from './model.js';

const exec = promisify(execFile);
export function createGitWorkspaceManager(repositories: Readonly<Record<string, { path: string; remote: string }>>,
  runtimeRoot: string, repoForRun: (run: Run) => string,
  sourceForRun?: (run: Run) => string | undefined,
  taskBaseForRun?: (run: Run) => string | undefined,
  baseRefForRun?: (run: Run) => string | undefined): WorkspaceManager {
  const clonePath = (run: Run) => {
    if (!/^[A-Za-z0-9_-]+$/.test(run.id)) throw new Error('Run ID is not a safe clone name');
    return resolve(runtimeRoot, 'clones', run.id);
  };
  async function verifyClone(path: string, remote: string): Promise<void> {
    if (!(await lstat(path)).isDirectory() || !(await lstat(resolve(path, '.git'))).isDirectory())
      throw new Error('Run clone is not an independent directory');
    const canonical = await realpath(path);
    const top = await realpath((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: path })).stdout.trim());
    const common = await realpath(resolve(path,
      (await exec('git', ['rev-parse', '--git-common-dir'], { cwd: path })).stdout.trim()));
    if (top !== canonical || common !== resolve(canonical, '.git') ||
        (await exec('git', ['remote', 'get-url', 'origin'], { cwd: path })).stdout.trim() !== remote)
      throw new Error('Run clone identity or origin changed');
  }
  const clonesRoot = resolve(runtimeRoot, 'clones');
  async function git(cwd: string, ...args: string[]): Promise<string> {
    return (await exec('git', ['-C', cwd, ...args, ], { cwd })).stdout.trim();
  }
  async function copyWorkspace(source: string, path: string): Promise<void> {
    try { await lstat(path); throw new Error('Run clone path already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (process.platform === 'darwin') {
      try { await exec('cp', ['-cR', source, path]); return; }
      catch { await rm(path, { recursive: true, force: true }); }
    }
    await cp(source, path, { recursive: true, errorOnExist: true, force: false });
  }
  async function sanitizeCopiedClone(path: string, remote: string, baseSha: string): Promise<void> {
    const gitDir = resolve(path, '.git');
    await rm(resolve(gitDir, 'agent-input'), { recursive: true, force: true });
    await rm(resolve(gitDir, 'hooks'), { recursive: true, force: true });
    await mkdir(resolve(gitDir, 'hooks'), { recursive: true, mode: 0o700 });
    await rm(resolve(gitDir, 'worktrees'), { recursive: true, force: true });
    await rm(resolve(gitDir, 'modules'), { recursive: true, force: true });
    await rm(resolve(gitDir, 'info', 'exclude'), { force: true });
    await rm(resolve(gitDir, 'config'), { force: true });
    await exec('git', ['-C', path, 'config', '--local', 'core.repositoryformatversion', '0']);
    await exec('git', ['-C', path, 'config', '--local', 'core.filemode', 'true']);
    await exec('git', ['-C', path, 'config', '--local', 'core.bare', 'false']);
    await exec('git', ['-C', path, 'config', '--local', 'remote.origin.url', remote]);
    await exec('git', ['-C', path, 'config', '--local', 'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*']);
    await exec('git', ['-C', path, 'reset', '--hard', baseSha]);
    await exec('git', ['-C', path, 'clean', '-ffdx']);
  }
  return { async prepare(run) {
    const repoKey = repoForRun(run);
    const repo = repositories[repoKey];
    if (!repo) throw new Error(`Unknown repository ${repoKey}`);
    const cwd = resolve(repo.path);
    const remote = (await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
    if (remote !== repo.remote) throw new Error(`Repository origin mismatch for ${repoKey}`);
    const developSource = run.stage === 'develop' && run.commitSha ? sourceForRun?.(run) : undefined;
    const pinned = run.stage === 'verify' || run.stage === 'review' ||
      (run.stage === 'develop' && !!run.commitSha && !!developSource);
    const expectedBase = run.stage === 'develop' ? baseRefForRun?.(run) : undefined;
    const path = clonePath(run);
    if (run.workspaceRef) {
      if (resolve(run.workspaceRef) !== path || !run.commitSha || !/^[a-f0-9]{40}$/.test(run.commitSha))
        throw new Error('Run workspace identity changed');
      await verifyClone(path, repo.remote);
      const head = await git(path, 'rev-parse', 'HEAD');
      if (head !== run.commitSha) throw new Error('Run clone HEAD changed before reuse');
      if (await git(path, 'status', '--porcelain=v1', '--untracked-files=all'))
        throw new Error('Run clone has uncommitted changes before reuse');
      return { repoKey, path, baseSha: run.commitSha };
    }
    await mkdir(clonesRoot, { recursive: true, mode: 0o700 });
    if (!(await lstat(clonesRoot)).isDirectory()) throw new Error('Run clone root is not a directory');
    await chmod(clonesRoot, 0o700);
    try { await lstat(path); throw new Error('Run clone path already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let source: string | undefined;
    let baseSha: string;
    if (pinned) {
      const candidate = run.stage === 'develop' ? developSource : sourceForRun?.(run);
      if (!candidate || resolve(candidate) === path || !resolve(candidate).startsWith(`${clonesRoot}/`))
        throw new Error('Pinned source clone is unavailable');
      source = await realpath(candidate);
      await verifyClone(source, repo.remote);
      baseSha = (await git(source, 'rev-parse', 'HEAD')) || '';
      if (baseSha !== run.commitSha || await git(source, 'status', '--porcelain=v1', '--untracked-files=all'))
        throw new Error('Pinned source clone changed');
    } else {
      const candidate = taskBaseForRun?.(run);
      if (candidate && resolve(candidate) !== path && resolve(candidate).startsWith(`${clonesRoot}/`)) {
        source = await realpath(candidate);
        await verifyClone(source, repo.remote);
        baseSha = await git(source, 'rev-parse', 'HEAD');
        if (await git(source, 'status', '--porcelain=v1', '--untracked-files=all'))
          throw new Error('Task base clone has uncommitted changes');
      } else baseSha = await git(cwd, 'rev-parse', 'HEAD');
    }
    if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('Git HEAD is not a full SHA');
    if (expectedBase && expectedBase !== baseSha)
      throw new Error('Task base does not match the available source clone');
    if (source) {
      await copyWorkspace(source, path);
      try {
        await chmod(path, 0o700);
        await sanitizeCopiedClone(path, repo.remote, baseSha);
        await verifyClone(path, repo.remote);
        if (await git(path, 'status', '--porcelain=v1', '--untracked-files=all'))
          throw new Error('Copied Run clone is not clean');
        return { repoKey, path, baseSha };
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    }
    await exec('git', ['clone', '--no-hardlinks', '--no-checkout', '--', cwd, path], { cwd });
    await chmod(path, 0o700);
    await exec('git', ['remote', 'set-url', 'origin', repo.remote], { cwd: path });
    await exec('git', ['checkout', '--detach', baseSha], { cwd: path });
    await verifyClone(path, repo.remote);
    return { repoKey, path, baseSha };
  }, async prepareCheckCopy(run) {
    const repo = repositories[repoForRun(run)];
    const source = clonePath(run);
    if (!repo || !run.commitSha || !/^[a-f0-9]{40}$/.test(run.commitSha))
      throw new Error('Check copy source has no pinned commit');
    await verifyClone(source, repo.remote);
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
    if (head !== run.commitSha) throw new Error('Check copy source HEAD changed');
    if ((await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: source })).stdout.trim())
      throw new Error('Check copy source has uncommitted changes');
    const root = resolve(runtimeRoot, 'check-workspaces');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const path = resolve(root, run.id);
    try { await lstat(path); throw new Error('Check workspace path already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // APFS clonefile keeps the check copy cheap; fall back to a regular copy elsewhere.
    if (process.platform === 'darwin') {
      try { await exec('cp', ['-cR', source, path]); }
      catch { await rm(path, { recursive: true, force: true });
        await cp(source, path, { recursive: true, errorOnExist: true, force: false }); }
    } else await cp(source, path, { recursive: true, errorOnExist: true, force: false });
    try {
      await chmod(path, 0o700);
      await verifyClone(path, repo.remote);
      const copiedHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
      if (copiedHead !== run.commitSha) throw new Error('Check copy HEAD changed');
      return { path, baseSha: run.commitSha };
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }, async cleanupCheckCopy(run) {
    if (!/^[A-Za-z0-9_-]+$/.test(run.id)) throw new Error('Run ID is not a safe check workspace name');
    const root = resolve(runtimeRoot, 'check-workspaces');
    const path = resolve(root, run.id);
    if (!path.startsWith(`${root}/`)) throw new Error('Check workspace is outside the runtime check root');
    await rm(path, { recursive: true, force: true });
  }, async verifyDevelopment(run) {
    const repoKey = repoForRun(run);
    const repo = repositories[repoKey];
    const path = clonePath(run);
    if (!repo || !run.workspaceRef || resolve(run.workspaceRef) !== path ||
        !run.commitSha || !/^[a-f0-9]{40}$/.test(run.commitSha))
      throw new Error('Development workspace or base SHA is unavailable');
    const cwd = resolve(repo.path);
    const remote = (await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
    if (remote !== repo.remote) throw new Error('Configured repository origin changed');
    await verifyClone(path, repo.remote);
    const headBefore = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
    await exec('git', ['merge-base', '--is-ancestor', run.commitSha, headBefore], { cwd: path });
    if ((await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: path })).stdout.trim())
      throw new Error('Development worktree contains uncommitted changes');
    const commitSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(commitSha) || commitSha !== headBefore || commitSha === run.commitSha)
      throw new Error('Development HEAD is missing, moved or unchanged');
    const diff = (await exec('git', ['diff', '--binary', run.commitSha, commitSha],
      { cwd: path, maxBuffer: 10 * 1024 * 1024 })).stdout;
    if (!diff.trim()) throw new Error('Development commit has no diff');
    const changedPaths = (await exec('git', ['diff', '--name-only', '--no-renames', run.commitSha, commitSha],
      { cwd: path })).stdout.split('\n').map(item => item.trim()).filter(Boolean);
    if ((await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim() !== commitSha)
      throw new Error('Development HEAD changed during verification');
    const evidenceDir = resolve(runtimeRoot, 'evidence');
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const diffRef = resolve(evidenceDir, `${randomUUID()}.patch`);
    await writeFile(diffRef, diff, { mode: 0o600, flag: 'wx' });
    return { baseSha: run.commitSha, commitSha, diffRef, changedPaths };
  }, async verifyAfterChecks(run, commitSha) {
    const repo = repositories[repoForRun(run)];
    const path = clonePath(run);
    if (!repo || !run.workspaceRef || resolve(run.workspaceRef) !== path || !/^[a-f0-9]{40}$/.test(commitSha))
      throw new Error('Development worktree identity changed after checks');
    const cwd = resolve(repo.path);
    if ((await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim() !== repo.remote)
      throw new Error('Configured repository origin changed after checks');
    await verifyClone(path, repo.remote);
    if ((await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim() !== commitSha)
      throw new Error('Development HEAD changed during local checks');
    if ((await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: path })).stdout.trim())
      throw new Error('Development worktree changed during local checks');
    if ((await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim() !== commitSha)
      throw new Error('Development HEAD changed during post-check verification');
  } };
}
