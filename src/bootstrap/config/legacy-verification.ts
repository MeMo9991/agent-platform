import type { GroupVerification } from '../../agent/worker/group-verifiers.js';

// The old boolean selected these exact commands by key. Keep the mapping at the legacy input.
export function legacyGroupVerification(projectKey: string): GroupVerification | undefined {
  switch (projectKey) {
    case 'devops-project-cloudbom':
      return { type: 'maven', scope: 'group', buildFile: 'CloudBom/pom.xml',
        testJvmArgs: ['-javaagent:${CACHE}/org/mockito/mockito-core/5.17.0/mockito-core-5.17.0.jar'] };
    case 'agent-platform':
      return { type: 'npm', checks: [
        { command: 'npm', args: ['run', 'typecheck'], timeoutMs: 120000 },
        { command: 'node', args: ['--import', 'tsx',
          '--test-skip-pattern=development Git proof checks|macOS sandbox limits|trusted check reuses|sandboxed process leaves|trusted npm ci prepares|formal entry rejects a second process|write attestation binds',
          '--test', 'tests'], timeoutMs: 180000 },
      ] };
    default:
      return undefined;
  }
}
