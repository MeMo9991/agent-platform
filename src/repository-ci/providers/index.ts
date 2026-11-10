import type { PlatformConfig } from '../../bootstrap/config.js';
import type { CodeHost } from '../model.js';
import { createGitHubCodeHost } from './github.js';
import { createGitLabCodeHost } from './gitlab.js';

export function createCodeHosts(config: PlatformConfig, fetcher: typeof fetch = fetch): Readonly<Record<string, CodeHost>> {
  const hosts: Record<string, CodeHost> = {};
  for (const repo of config.repositories) {
    if (hosts[repo.repoKey]) throw new Error(`Duplicate repository ${repo.repoKey}`);
    if (repo.provider === 'github') hosts[repo.repoKey] = createGitHubCodeHost(repo, fetcher);
    else if (repo.provider === 'gitlab') hosts[repo.repoKey] = createGitLabCodeHost(repo, fetcher);
    else throw new Error(`Unknown provider for ${repo.repoKey}`);
  }
  return hosts;
}
