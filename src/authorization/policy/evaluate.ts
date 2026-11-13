import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Decision, Effect, PolicyContext, PolicyHook } from './model.js';
import type { ResolvedReview } from './config.js';
import { builtinHooks } from './hooks.js';

export type AuditSink = (entry: Record<string, unknown>) => void;
export const policyModes = ['off', 'shadow', 'warn', 'enforce'] as const;
export type PolicyMode = typeof policyModes[number];
export type PolicyOutcome = { decision: Decision; enforced: boolean; mode: PolicyMode; fingerprint: string };

const rank: Record<Effect, number> = { allow: 0, 'require-approval': 1, deny: 2 };

function defaultAudit(entry: Record<string, unknown>): void {
  try {
    mkdirSync('.runtime', { recursive: true, mode: 0o700 });
    appendFileSync(resolve('.runtime', 'policy-decisions.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* 审计失败不能影响门禁判定 */ }
}

let audit: AuditSink = defaultAudit;
export function shouldWarn(outcome?: PolicyOutcome): boolean {
  return Boolean(outcome && outcome.mode === 'warn' && outcome.decision.effect !== 'allow');
}

export function policyWarning(ctx: PolicyContext, outcome: PolicyOutcome) {
  return { gate: ctx.gate, ruleId: outcome.decision.ruleId,
    effect: outcome.decision.effect, reason: outcome.decision.reason };
}

export function setPolicyAuditSink(sink: AuditSink | undefined): void { audit = sink ?? defaultAudit; }

function gateDecision(ctx: PolicyContext, config: ResolvedReview['config']): Decision {
  if (ctx.gate === 'merge')
    return { effect: 'require-approval', ruleId: 'gate:merge', reason: '合并必须人工审批' };
  if (ctx.gate === 'edit')
    return config.gates.edit === 'approval'
      ? { effect: 'require-approval', ruleId: 'gate:edit', reason: '仓库策略要求改代码前审批' }
      : { effect: 'allow', ruleId: 'gate:edit', reason: '允许自动改代码' };
  if (ctx.gate === 'openPr')
    return config.gates.openPr === 'approval'
      ? { effect: 'require-approval', ruleId: 'gate:openPr', reason: '仓库策略要求提交 PR 前审批' }
      : { effect: 'allow', ruleId: 'gate:openPr', reason: '允许自动提交 PR' };
  return { effect: 'allow', ruleId: `gate:${ctx.gate}`, reason: '无额外门禁' };
}

/** 统一求值入口：跑注册的钩子，取最严格效果，记录审计；未配置策略时返回 undefined（行为不变）。 */
export function decide(ctx: PolicyContext, resolved: ResolvedReview | undefined,
  hooks: readonly PolicyHook[] = builtinHooks, sink: AuditSink = audit): PolicyOutcome | undefined {
  if (!resolved || resolved.config.mode === 'off') return undefined;
  const decisions: Decision[] = [];
  for (const hook of hooks) {
    if (!hook.gates.includes(ctx.gate)) continue;
    try {
      const result = hook.evaluate(ctx, resolved.config);
      if (result) decisions.push(result);
    } catch (error) {
      decisions.push({ effect: 'deny', ruleId: hook.id,
        reason: `钩子执行失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  decisions.push(gateDecision(ctx, resolved.config));
  const strictest = decisions.reduce((left, right) => rank[right.effect] > rank[left.effect] ? right : left);
  sink({ at: new Date().toISOString(), gate: ctx.gate, repoKey: ctx.repoKey, taskId: ctx.taskId,
    runId: ctx.runId, effect: strictest.effect, ruleId: strictest.ruleId, reason: strictest.reason,
    matches: decisions.map(item => item.ruleId), fingerprint: resolved.fingerprint,
    bundle: resolved.config.bundle, mode: resolved.config.mode,
    files: ctx.paths?.length, hasDiff: Boolean(ctx.diff) });
  return { decision: strictest, enforced: resolved.config.mode === 'enforce',
    mode: resolved.config.mode, fingerprint: resolved.fingerprint };
}
