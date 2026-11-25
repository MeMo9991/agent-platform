import type { GroupVerifier, MavenVerification } from '../group-verifiers.js';

export function mavenVerifier({ buildFile, scope, testJvmArgs }: MavenVerification,
  tools: { settings?: string; javaHome?: string }): GroupVerifier {
  const args = [...(tools.settings ? ['-gs', tools.settings] : []), '-B', '-ntp', '-f', buildFile];
  const jvmArgs = testJvmArgs?.length ? [`-DargLine=${testJvmArgs.join(' ')}`] : [];
  const verify = { mode: 'platform', workspace: 'copy', prepare: [],
    env: { MAVEN_OPTS: '-Dmaven.repo.local=${CACHE}', ...(tools.javaHome ? { JAVA_HOME: tools.javaHome } : {}) },
    cacheKeyFiles: [buildFile] } satisfies GroupVerifier['verify'];
  if (scope === 'repository')
    return { verify, checks: [{ command: 'mvn', args: [...args, ...jvmArgs, 'verify'], timeoutMs: 600000 }] };

  const modules = [...args, '-pl', '${CHANGED_MODULES}'];
  return {
    buildFile, moduleSelection: 'changed-maven', verify,
    checks: [
      { command: 'mvn', args: [...modules, '-am', '-DskipTests', 'install'], timeoutMs: 600000 },
      { command: 'mvn', args: [...modules, '-Dtest=${CHANGED_TESTS}', '-Dsurefire.failIfNoSpecifiedTests=false',
        ...jvmArgs, 'verify'], timeoutMs: 600000 },
    ],
  };
}
