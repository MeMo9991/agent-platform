import type { Decision, PolicyHook } from './model.js';
import type { ReviewConfig } from './config.js';

const secretContent = /\b(api[_-]?key|private[_-]?key|secret|credential|password|token)\b\s*[:=]|process\.env\.|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i;
const binaryDiff = /^(GIT binary patch|Binary files )/m;
const changedLines = (diff: string) => diff.split('\n').filter(line => /^[+-](?![+-])/.test(line)).length;

function decision(effect: Decision['effect'], ruleId: string, reason: string): Decision {
  return { effect, ruleId, reason };
}

/** 不变量：任何仓库都不能放宽的底线检查。 */
export const invariants: PolicyHook = { id: 'invariants',
  gates: ['intake', 'edit', 'develop-complete', 'openPr', 'merge'],
  evaluate(ctx) {
    if (ctx.gate === 'develop-complete' && ctx.baseSha && ctx.commitSha && ctx.baseSha === ctx.commitSha)
      return decision('deny', 'no-new-commit', '本轮没有产生新提交');
    if (ctx.gate === 'openPr' && ctx.baseSha && ctx.commitSha && ctx.baseSha !== ctx.commitSha)
      return decision('deny', 'sha-mismatch', '变更 SHA 与审查 SHA 不一致');
    if (ctx.checks && (ctx.checks.length === 0 || ctx.checks.some(check =>
      check.result !== 'passed' || check.exitCode !== 0 || check.terminationConfirmed === false)))
      return decision('require-approval', 'checks-not-passing', '本地检查未全部通过');
    if (ctx.review && (ctx.review.verdict !== 'pass' || ctx.review.findingsLength > 0))
      return decision('require-approval', 'review-not-clean', '审查未通过或仍有未处理意见');
    if (ctx.diff) {
      if (binaryDiff.test(ctx.diff)) return decision('deny', 'binary-diff', '二进制变更不允许自动');
      if (secretContent.test(ctx.diff))
        return decision('require-approval', 'secret-content', '变更内容疑似包含密钥或环境变量');
    }
    if (ctx.gate === 'merge') return decision('require-approval', 'merge-human', '合并必须人工审批');
    return undefined;
  } };

/** 规模上限：文件数与改动行数（通用默认，仓库层后续可收紧）。 */
export const limits: PolicyHook = { id: 'limits', gates: ['develop-complete', 'openPr'],
  evaluate(ctx, config: ReviewConfig) {
    if (ctx.paths && ctx.paths.length > config.limits.maxFiles)
      return decision('require-approval', 'too-many-files',
        `变更文件 ${ctx.paths.length} 个，超过上限 ${config.limits.maxFiles}`);
    if (ctx.diff && changedLines(ctx.diff) > config.limits.maxChangedLines)
      return decision('require-approval', 'too-many-lines',
        `改动行数超过上限 ${config.limits.maxChangedLines}`);
    return undefined;
  } };

/** 额外内容红线：平台配置里追加的禁止内容。 */
export const content: PolicyHook = { id: 'content', gates: ['develop-complete', 'openPr'],
  evaluate(ctx, config: ReviewConfig) {
    if (!ctx.diff) return undefined;
    const hit = config.contentDeny.find(pattern => ctx.diff!.includes(pattern));
    return hit ? decision('require-approval', 'content-deny', `变更包含禁止内容：${hit}`) : undefined;
  } };

export const builtinHooks: readonly PolicyHook[] = [invariants, limits, content];
