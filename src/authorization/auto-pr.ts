import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { SourceEvent } from '../event/model.js';
import type { repositoryConfig } from '../repository-ci/model.js';
import type { TaskMandate } from '../agent/task/model.js';

type Repository = z.infer<typeof repositoryConfig>;

export function autoPrRuleRef(repo: Repository, policyVersion: string): string | undefined {
  if (repo.repoKey !== 'agent-platform' || !repo.autoPr?.enabled || !repo.autoPr.allowedPrefixes.length) return undefined;
  return createHash('sha256').update(JSON.stringify([repo.repoKey, repo.targetBranch,
    repo.autoPr.allowedPrefixes, policyVersion])).digest('hex');
}

export function autoPrMandate(event: SourceEvent, repo: Repository, policyVersion: string): TaskMandate | undefined {
  const ruleRef = autoPrRuleRef(repo, policyVersion);
  if (!ruleRef || event.sourceId !== `manual:${repo.repoKey}` || event.repoKey !== repo.repoKey ||
      event.metaData.autoPr !== true || event.attachments.length ||
      /只读|仅查看|无需修改|不要修改(?:代码|仓库|项目|任何文件|所有文件|任何内容)|do not (edit|modify|change)|read.only/i.test(event.body)) return undefined;
  return { sourceEventId: event.id, repoKey: repo.repoKey, goal: event.title,
    allowedActions: ['investigate', 'edit', 'open_pr'], maxAutoRisk: 'high', policyVersion,
    authority: { kind: 'auto_pr', ruleRef } };
}

export function autoPrPathsAllowed(paths: readonly string[], repo: Repository): boolean {
  return !!autoPrRuleRef(repo, '') && paths.length > 0 &&
    paths.every(path => repo.autoPr!.allowedPrefixes.some(prefix => path.startsWith(prefix)) &&
      !/(^|\/)(auth|authorization|policy|security|permission|credential|secret|sandbox|migration|deploy|release|workflow|config)(\/|\.|$)/i.test(path));
}

export function autoPrDiffAllowed(diff: string): boolean {
  return !diff.split('\n').some(line => /^[+-](?![+-])/.test(line) &&
    /\b(api[_-]?key|private[_-]?key|auth|permission|credential|secret|token|password|migration|deploy|release)\b|process\.env\.|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i.test(line));
}
