import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Run, WorkspaceManager } from './model.js';

const exec = promisify(execFile);
export function createGitWorkspaceManager(repositories: Readonly<Record<string, { path: string; remote: string }>>,
  runtimeRoot: string, repoForRun: (run: Run) => string,
  sourceForRun?: (run: Run) => string | undefined): WorkspaceManager {
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
  return { async prepare(run) {
    const repoKey = repoForRun(run);
    const repo = repositories[repoKey];
    if (!repo) throw new Error(`Unknown repository ${repoKey}`);
    const cwd = resolve(repo.path);
    const remote = (await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
    if (remote !== repo.remote) throw new Error(`Repository origin mismatch for ${repoKey}`);
    const pinned = run.stage === 'verify' || run.stage === 'review' ||
      (run.stage === 'develop' && !!run.commitSha && !!sourceForRun?.(run));
    const baseSha = pinned ? run.commitSha : (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('Git HEAD is not a full SHA');
    const path = clonePath(run);
    if (run.workspaceRef) {
      if (resolve(run.workspaceRef) !== path || !run.commitSha || !/^[a-f0-9]{40}$/.test(run.commitSha))
        throw new Error('Run workspace identity changed');
      await verifyClone(path, repo.remote);
      const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
      if (head !== run.commitSha) throw new Error('Run clone HEAD changed before reuse');
      if ((await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: path })).stdout.trim())
        throw new Error('Run clone has uncommitted changes before reuse');
      return { repoKey, path, baseSha: run.commitSha };
    }
    const clonesRoot = resolve(runtimeRoot, 'clones');
    await mkdir(clonesRoot, { recursive: true, mode: 0o700 });
    if (!(await lstat(clonesRoot)).isDirectory()) throw new Error('Run clone root is not a directory');
    await chmod(clonesRoot, 0o700);
    try { await lstat(path); throw new Error('Run clone path already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let source = cwd;
    if (pinned) {
      const candidate = sourceForRun?.(run);
      if (!candidate || resolve(candidate) === path || !resolve(candidate).startsWith(`${resolve(runtimeRoot, 'clones')}/`))
        throw new Error('Pinned source clone is unavailable');
      source = await realpath(candidate);
      await verifyClone(source, repo.remote);
      if ((await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim() !== baseSha ||
          (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: source })).stdout.trim())
        throw new Error('Pinned source clone changed');
    }
    await exec('git', ['clone', '--no-hardlinks', '--no-checkout', '--', source, path], { cwd });
    await chmod(path, 0o700);
    await exec('git', ['remote', 'set-url', 'origin', repo.remote], { cwd: path });
    await exec('git', ['checkout', '--detach', baseSha], { cwd: path });
    await verifyClone(path, repo.remote);
    return { repoKey, path, baseSha };
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
    if ((await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim() !== commitSha)
      throw new Error('Development HEAD changed during verification');
    const evidenceDir = resolve(runtimeRoot, 'evidence');
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const diffRef = resolve(evidenceDir, `${randomUUID()}.patch`);
    await writeFile(diffRef, diff, { mode: 0o600, flag: 'wx' });
    return { baseSha: run.commitSha, commitSha, diffRef };
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
