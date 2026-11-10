import type { TaskMandate } from '../agent/task/model.js';
import type { z } from 'zod';
import type { repositoryConfig } from '../repository-ci/model.js';

type Risk = 'low' | 'medium' | 'high' | 'unknown';
type Decision = { kind: 'allow' | 'deny' | 'needs_scope' | 'needs_approval'; reason: string; risk: Risk };
const rank = { low: 0, medium: 1, high: 2, unknown: 3 } as const;
const sensitive = /(^|\/)(\.env[^/]*|[^/]*(secret|credential)[^/]*|migrations|deploy|release)(\/|$)|^\.github\/workflows\/|^\.gitlab-ci\.yml$/i;

export function evaluateStage5Action(input: { mandate: TaskMandate; repository: z.infer<typeof repositoryConfig>;
  action: 'open_pr' | 'merge'; targetBranch: string; sourceSha: string; targetSha: string;
  changedPaths: readonly string[]; diff: string; modelRisk?: Risk; approvalValid: boolean }): Decision {
  const { mandate, repository } = input;
  if (mandate.repoKey !== repository.repoKey || input.targetBranch !== repository.targetBranch ||
      !/^[a-f0-9]{40}$/.test(input.sourceSha) || !/^[a-f0-9]{40}$/.test(input.targetSha))
    return { kind: 'deny', reason: 'Repository, target branch or SHA is invalid', risk: 'unknown' };
  if (!mandate.allowedActions.includes(input.action))
    return { kind: 'needs_scope', reason: 'Action is outside the Task Mandate', risk: 'unknown' };
  if (input.changedPaths.length === 0 || input.changedPaths.some(path =>
    !path || path.startsWith('/') || path.includes('..') || path.includes('\\')))
    return { kind: 'deny', reason: 'Changed paths are missing or unsafe', risk: 'unknown' };
  if (typeof input.diff !== 'string' || !input.diff.includes('diff --git ') || !/^@@ /m.test(input.diff) ||
      /^(GIT binary patch|Binary files )/m.test(input.diff))
    return { kind: 'deny', reason: 'Development diff cannot be inspected', risk: 'unknown' };
  const changedLines = input.diff.split('\n').filter(line => /^[+-](?![+-])/.test(line));
  if (!changedLines.length) return { kind: 'deny', reason: 'Development diff has no changed lines', risk: 'unknown' };
  const hardRisk: Risk = input.changedPaths.some(path => sensitive.test(path)) ||
    changedLines.some(line => /\b(secret|credential|permission|authorization|token|password|migration|deploy|release)\b|process\.env\./i.test(line)) ? 'high'
    : input.action === 'merge' ? 'high' : 'medium';
  const risk = input.modelRisk && rank[input.modelRisk] > rank[hardRisk] ? input.modelRisk : hardRisk;
  if (risk === 'unknown') return { kind: 'deny', reason: 'Risk is unknown', risk };
  if (rank[risk] > rank[mandate.maxAutoRisk])
    return { kind: 'needs_scope', reason: 'Risk exceeds the current Task Mandate', risk };
  if (!input.approvalValid) return { kind: 'needs_approval', reason: 'Current action approval is required', risk };
  return { kind: 'allow', reason: 'Current Mandate and action approval match', risk };
}
