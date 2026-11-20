import type { GroupVerifier } from '../group-verifiers.js';

export const agentPlatformVerifier: GroupVerifier = {
    checks: [
      { command: 'npm', args: ['run', 'typecheck'], timeoutMs: 120000 },
      { command: 'node', args: ['--import', 'tsx',
        '--test-skip-pattern=development Git proof checks|macOS sandbox limits|trusted check reuses|sandboxed process leaves|trusted npm ci prepares|formal entry rejects a second process|write attestation binds',
        '--test', 'tests'], timeoutMs: 180000 },
    ],
    verify: { mode: 'platform', workspace: 'copy',
      prepare: [{ command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 300000 }],
      env: { npm_config_cache: '${CACHE}/npm' }, cacheKeyFiles: ['package-lock.json', 'package.json'] },
  };
