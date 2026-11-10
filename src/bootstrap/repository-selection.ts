import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RepositorySelection } from '../event/sources/devops/defects.js';
import type { PlatformConfig } from './config.js';

export function createRepositorySelector(group: PlatformConfig['projectGroups'][number],
  repositories: PlatformConfig['repositories']): (title: string, body: string) => RepositorySelection | undefined {
  if (!group.searchRoot) return () => undefined;
  let root: string;
  try { root = realpathSync(group.searchRoot); } catch { return () => undefined; }
  const ready = group.repoKeys.flatMap(repoKey => {
    const repo = repositories.find(item => item.repoKey === repoKey);
    if (!repo?.localPath) return [];
    try {
      const path = realpathSync(resolve(repo.localPath));
      const within = relative(root, path);
      if (!within || within === '..' || within.startsWith('../') || isAbsolute(within) ||
          execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path, encoding: 'utf8', timeout: 2000 }).trim() !== path ||
          execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: path, encoding: 'utf8', timeout: 2000 }).trim() !==
            `${repo.hostUrl}/${repo.projectRef}.git`) return [];
      const files = execFileSync('git', ['ls-files', '-z'], { cwd: path, encoding: 'utf8', timeout: 5000,
        maxBuffer: 8 * 1024 * 1024 })
        .split('\0').map(file => file.split('/').at(-1)!.toLowerCase());
      return [{ repoKey, files, path, remote: `${repo.hostUrl}/${repo.projectRef}.git` }];
    } catch { return []; }
  });
  const fallback = ready.find(repo => repo.repoKey === group.defaultRepoKey);
  const available = (repo: typeof ready[number]) => {
    try { return realpathSync(repo.path) === repo.path &&
      execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo.path, encoding: 'utf8', timeout: 2000 }).trim() === repo.path &&
      execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo.path, encoding: 'utf8', timeout: 2000 }).trim() === repo.remote;
    } catch { return false; }
  };
  return (title, body) => {
    const text = `${title}\n${body}`.slice(0, 4096).toLowerCase();
    const names = new Set(text.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? []);
    const tokens = [...new Set(text.match(/[a-z][a-z0-9_]{5,}/g) ?? [])]
      .filter(token => !['cloudbom', 'request', 'response', 'service', 'controller'].includes(token)).slice(0, 6);
    const ranked = ready.map(repo => ({ repoKey: repo.repoKey,
      name: names.has(repo.repoKey.toLowerCase()),
      files: tokens.filter(token => repo.files.some(file => file.includes(token))).length }))
      .sort((a, b) => (Number(b.name) * 3 + b.files) - (Number(a.name) * 3 + a.files));
    const first = ranked[0];
    const score = first ? Number(first.name) * 3 + first.files : 0;
    const second = ranked[1];
    // shortcut: filename evidence cannot classify Chinese-only reports, use reviewed semantic triage when needed.
    if (first && score >= 2 && score > (second ? Number(second.name) * 3 + second.files : 0) &&
        available(ready.find(repo => repo.repoKey === first.repoKey)!))
      return { repoKey: first.repoKey, reason: first.name ? 'repository-name' : 'file-name' };
    return fallback && available(fallback) ? { repoKey: fallback.repoKey, reason: 'default' } : undefined;
  };
}
