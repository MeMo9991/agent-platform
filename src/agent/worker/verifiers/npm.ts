import type { GroupVerifier, NpmVerification } from '../group-verifiers.js';

export function npmVerifier({ checks }: NpmVerification): GroupVerifier {
  return {
    checks,
    verify: { mode: 'platform', workspace: 'copy',
      prepare: [{ command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 300000 }],
      env: { npm_config_cache: '${CACHE}/npm' }, cacheKeyFiles: ['package-lock.json', 'package.json'] },
  };
}
