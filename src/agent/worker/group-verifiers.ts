import type { CheckCommand, VerifyConfig } from '../../repository-ci/model.js';
import { agentPlatformVerifier } from './verifiers/agent-platform.js';
import { cloudbomVerifier } from './verifiers/cloudbom.js';

export interface GroupVerifier {
  buildFile?: string;
  moduleSelection?: 'changed-maven';
  checks: readonly CheckCommand[];
  verify: VerifyConfig;
}

// Register one implementation per project group. Configuration only enables it.
export const groupVerifiers: Readonly<Record<string, GroupVerifier>> = {
  'agent-platform': agentPlatformVerifier,
  'devops-project-cloudbom': cloudbomVerifier,
};

export function groupVerifier(projectKey: string): GroupVerifier | undefined {
  const verifier = groupVerifiers[projectKey];
  if (projectKey !== 'devops-project-cloudbom' || !verifier) return verifier;
  const settings = process.env.AGENT_PLATFORM_CLOUDBOM_MAVEN_SETTINGS;
  const javaHome = process.env.AGENT_PLATFORM_CLOUDBOM_JAVA_HOME;
  return { ...verifier,
    checks: settings ? verifier.checks.map(check => ({ ...check,
      args: ['-gs', settings, ...check.args] })) : verifier.checks,
    verify: javaHome ? { ...verifier.verify, env: { ...verifier.verify.env, JAVA_HOME: javaHome } }
      : verifier.verify };
}
