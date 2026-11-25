import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { checkCommand, type CheckCommand, type VerifyConfig } from '../../repository-ci/model.js';
import { id } from '../../shared/model.js';
import { mavenVerifier } from './verifiers/maven.js';
import { npmVerifier } from './verifiers/npm.js';

export const groupVerification = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('maven'), scope: z.enum(['repository', 'group']).default('repository'),
    buildFile: id.refine(file => !isAbsolute(file) && !file.includes('\\') && file.split('/').every(
      segment => segment !== '' && segment !== '.' && segment !== '..'),
    'Maven buildFile must be a relative path inside its workspace').default('pom.xml'),
    testJvmArgs: z.array(id).optional() }),
  z.strictObject({ type: z.literal('npm'), checks: z.array(checkCommand.strict()).min(1) }),
]);
export type GroupVerification = z.infer<typeof groupVerification>;
export type MavenVerification = Extract<GroupVerification, { type: 'maven' }>;
export type NpmVerification = Extract<GroupVerification, { type: 'npm' }>;

export interface GroupVerifier {
  buildFile?: string;
  moduleSelection?: 'changed-maven';
  checks: readonly CheckCommand[];
  verify: VerifyConfig;
}

export function groupVerifier(verification: GroupVerification): GroupVerifier {
  if (verification.type === 'npm') return npmVerifier(verification);
  return mavenVerifier(verification, { settings: process.env.MAVEN_SETTINGS, javaHome: process.env.JAVA_HOME });
}
