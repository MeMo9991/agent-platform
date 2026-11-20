import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function changedMavenModules(repo: string, baseSha: string, commitSha: string): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{40}$/.test(commitSha) || baseSha === commitSha)
    throw new Error('Changed-module selection needs distinct pinned commits');
  await exec('git', ['merge-base', '--is-ancestor', baseSha, commitSha], { cwd: repo });
  const changed = (await exec('git', ['diff', '--name-only', '-z', '--no-renames', baseSha, commitSha],
    { cwd: repo, maxBuffer: 10 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  if (!changed.length) throw new Error('Pinned commits have no changed files');

  const modules = new Set<string>();
  async function visit(directory: string): Promise<void> {
    if (modules.has(directory)) throw new Error('Maven reactor has duplicate modules');
    const pom = resolve(repo, directory, 'pom.xml');
    if (!(await lstat(pom)).isFile()) throw new Error(`Maven module ${directory} has no regular pom.xml`);
    modules.add(directory);
    const xml = (await readFile(pom, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
    for (const block of xml.matchAll(/<modules>\s*([\s\S]*?)\s*<\/modules>/g)) {
      for (const match of block[1]!.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
        const name = match[1]!.trim();
        if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..'))
          throw new Error(`Unsafe Maven module path ${name}`);
        await visit(directory === '.' ? name : `${directory}/${name}`);
      }
    }
  }
  await visit('.');

  const selected = new Set<string>();
  for (const file of changed) {
    if (file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Git diff contains an unsafe path');
    let directory = dirname(file);
    while (directory !== '.') {
      try {
        if ((await lstat(resolve(repo, directory, 'pom.xml'))).isFile() && !modules.has(directory))
          throw new Error(`Changed Maven module ${directory} is outside the reactor`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      directory = dirname(directory);
    }
    const owner = [...modules].filter(module => module !== '.' &&
      (file === `${module}/pom.xml` || file.startsWith(`${module}/`)))
      .sort((a, b) => b.length - a.length)[0] ?? '.';
    for (const module of modules) {
      if (module === owner || (file === `${owner}/pom.xml` && module.startsWith(`${owner}/`)) || owner === '.')
        selected.add(module);
    }
  }
  return [...selected].sort();
}

export async function changedMavenTests(repo: string, baseSha: string, commitSha: string): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{40}$/.test(commitSha))
    throw new Error('Changed-test selection needs pinned commits');
  const changed = (await exec('git', ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACM',
    baseSha, commitSha], { cwd: repo, maxBuffer: 10 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  return [...new Set(changed.flatMap(file => {
    if (file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Git diff contains an unsafe path');
    const match = /(?:^|\/)src\/test\/java\/(?:[A-Za-z0-9_]+\/)*([A-Za-z_$][A-Za-z0-9_$]*(?:Test|Tests))\.java$/.exec(file);
    return match ? [match[1]!] : [];
  }))].sort();
}
