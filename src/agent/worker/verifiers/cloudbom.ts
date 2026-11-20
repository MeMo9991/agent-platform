import type { GroupVerifier } from '../group-verifiers.js';

export const cloudbomVerifier: GroupVerifier = {
    buildFile: 'CloudBom/pom.xml', moduleSelection: 'changed-maven',
    checks: [
      { command: 'mvn', args: ['-B', '-ntp', '-f', 'CloudBom/pom.xml', '-pl', '${CHANGED_MODULES}',
        '-am', '-DskipTests', 'install'], timeoutMs: 600000 },
      // shortcut: Mockito agent path follows the current dependency version; update it when CloudBOM upgrades Mockito.
      { command: 'mvn', args: ['-B', '-ntp', '-f', 'CloudBom/pom.xml', '-pl', '${CHANGED_MODULES}',
        '-Dtest=${CHANGED_TESTS}', '-Dsurefire.failIfNoSpecifiedTests=false',
        '-DargLine=-javaagent:${CACHE}/org/mockito/mockito-core/5.17.0/mockito-core-5.17.0.jar',
        'verify'], timeoutMs: 600000 },
    ],
    verify: { mode: 'platform', workspace: 'copy', prepare: [],
      env: { MAVEN_OPTS: '-Dmaven.repo.local=${CACHE}' }, cacheKeyFiles: ['CloudBom/pom.xml'] },
  };
