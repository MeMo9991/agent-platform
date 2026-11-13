import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { SourceEvent } from '../event/model.js';
import type { repositoryConfig } from '../repository-ci/model.js';
import type { TaskMandate } from '../agent/task/model.js';

type Repository = z.infer<typeof repositoryConfig>;
const codeChangeIntent = /修改|修复|新增|增加|实现|调整|优化|删除|去掉|移除|隐藏|改为|改成|展示|显示|下线|替换|重构|更新|改动|完善|改进|\b(?:fix|change|add|implement|update|remove|refactor)\b/i;
const readOnlyIntent = /只读|仅查看|无需修改|不需要修改|不要修改(?:代码|仓库|项目|任何文件|所有文件|任何内容)|do not (edit|modify|change)|read.only/i;
const investigationIntent = /^(?:(?:请|帮我|先)?(?:调查|分析|解释|查看|检查|确认|排查|说明|评估|研究|告诉我|为什么|如何|怎么|是否)|(?:please )?(?:investigate|analyze|explain|inspect|check|review|why|how|whether)\b)/i;

export function hasCodeChangeIntent(body: string): boolean {
  return !investigationIntent.test(body.trim()) &&
    codeChangeIntent.test(body.replace(/不要(?:修改|更改|改动)[^，。；;\n]*/g, '')) && !readOnlyIntent.test(body);
}

export function autoPrRuleRef(repo: Repository, policyVersion: string): string | undefined {
  if (repo.repoKey !== 'agent-platform' || !repo.autoPr?.enabled || !repo.autoPr.allowedPrefixes.length) return undefined;
  return createHash('sha256').update(JSON.stringify([repo.repoKey, repo.targetBranch,
    repo.autoPr.allowedPrefixes, policyVersion])).digest('hex');
}

export function autoPrMandate(event: SourceEvent, repo: Repository, policyVersion: string): TaskMandate | undefined {
  const ruleRef = autoPrRuleRef(repo, policyVersion);
  if (!ruleRef || event.sourceId !== `manual:${repo.repoKey}` || event.repoKey !== repo.repoKey ||
      event.kind !== 'manual_task' || event.attachments.length || !hasCodeChangeIntent(event.body)) return undefined;
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
