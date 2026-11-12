import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReview } from '../src/authorization/policy/config.js';
import { decide, setPolicyAuditSink } from '../src/authorization/policy/evaluate.js';

import type { PolicyContext, PolicyHook } from '../src/authorization/policy/model.js';

// 测试不写真实审计日志
setPolicyAuditSink(() => {});

const sha = 'a'.repeat(40);
const clean: PolicyContext = { gate: 'openPr', repoKey: 'repo', paths: ['src/a.ts'],
  diff: '+export const a = 1;\n', checks: [{ result: 'passed', exitCode: 0, terminationConfirmed: true }],
  review: { verdict: 'pass', findingsLength: 0 } };

function withReview(config: Record<string, unknown>) {
  return resolveReview(config, 'p1');
}

test('未配置 review 时不做任何判定，调用方行为不变', () => {
  assert.equal(decide(clean, undefined), undefined);
});

test('干净变更在 shadow 模式下判为 allow 且不强制', () => {
  const outcome = decide(clean, withReview({}));
  assert.equal(outcome?.decision.effect, 'allow');
  assert.equal(outcome?.enforced, false);
  assert.equal(outcome?.decision.ruleId, 'gate:openPr');
});

test('enforce 模式下标记为强制', () => {
  const outcome = decide(clean, withReview({ mode: 'enforce' }));
  assert.equal(outcome?.enforced, true);
  assert.equal(outcome?.mode, 'enforce');
});

test('off 模式完全关闭，warn 模式只记录不强制', () => {
  assert.equal(decide(clean, withReview({ mode: 'off' })), undefined);
  const warn = decide({ ...clean, checks: [{ result: 'failed', exitCode: 1, terminationConfirmed: true }] },
    withReview({ mode: 'warn' }));
  assert.equal(warn?.mode, 'warn');
  assert.equal(warn?.enforced, false);
  assert.equal(warn?.decision.effect, 'require-approval');
});

test('检查未通过、审查未通过、二进制、密钥分别命中对应规则', () => {
  const check = decide({ ...clean, checks: [{ result: 'failed', exitCode: 1, terminationConfirmed: true }] }, withReview({ mode: 'enforce' }));
  assert.equal(check?.decision.effect, 'require-approval');
  assert.equal(check?.decision.ruleId, 'checks-not-passing');
  const review = decide({ ...clean, review: { verdict: 'block', findingsLength: 1 } }, withReview({ mode: 'enforce' }));
  assert.equal(review?.decision.ruleId, 'review-not-clean');
  const binary = decide({ ...clean, diff: 'Binary files a.png and b.png differ\n' }, withReview({ mode: 'enforce' }));
  assert.equal(binary?.decision.effect, 'deny');
  assert.equal(binary?.decision.ruleId, 'binary-diff');
  const secret = decide({ ...clean, diff: '+const token = "abc";\n' }, withReview({ mode: 'enforce' }));
  assert.equal(secret?.decision.effect, 'require-approval');
  assert.equal(secret?.decision.ruleId, 'secret-content');
});

test('openPr 的 SHA 不一致直接拒绝，合并门恒为人工', () => {
  const mismatch = decide({ ...clean, baseSha: sha, commitSha: 'b'.repeat(40) }, withReview({ mode: 'enforce' }));
  assert.equal(mismatch?.decision.effect, 'deny');
  assert.equal(mismatch?.decision.ruleId, 'sha-mismatch');
  const merge = decide({ ...clean, gate: 'merge' }, withReview({ mode: 'enforce' }));
  assert.equal(merge?.decision.effect, 'require-approval');
  assert.equal(merge?.decision.ruleId, 'merge-human');
});

test('规模上限与额外内容红线可配', () => {
  const files = decide({ ...clean, paths: Array.from({ length: 11 }, (_, index) => `src/${index}.ts`) },
    withReview({ mode: 'enforce', limits: { maxFiles: 10, maxChangedLines: 2000 } }));
  assert.equal(files?.decision.ruleId, 'too-many-files');
  const lines = decide({ ...clean, diff: `+${'x'.repeat(10)}\n`.repeat(21) },
    withReview({ mode: 'enforce', limits: { maxFiles: 50, maxChangedLines: 20 } }));
  assert.equal(lines?.decision.ruleId, 'too-many-lines');
  const content = decide({ ...clean, diff: '+// FIXME\n' }, withReview({ mode: 'enforce', contentDeny: ['FIXME'] }));
  assert.equal(content?.decision.ruleId, 'content-deny');
});

test('gate:edit 可配置为需要审批', () => {
  const outcome = decide({ gate: 'edit', repoKey: 'repo' },
    withReview({ mode: 'enforce', gates: { edit: 'approval', openPr: 'auto', merge: 'human' } }));
  assert.equal(outcome?.decision.effect, 'require-approval');
  assert.equal(outcome?.decision.ruleId, 'gate:edit');
});

test('钩子抛错按 fail-closed 处理为 deny', () => {
  const broken: PolicyHook = { id: 'broken', gates: ['openPr'], evaluate() { throw new Error('boom'); } };
  const outcome = decide(clean, withReview({ mode: 'enforce' }), [broken]);
  assert.equal(outcome?.decision.effect, 'deny');
  assert.match(outcome?.decision.reason ?? '', /boom/);
});

test('规则变化会改变指纹，审计会记录命中规则', () => {
  const first = withReview({ bundle: 'v1' });
  const second = withReview({ bundle: 'v2' });
  assert.notEqual(first?.fingerprint, second?.fingerprint);
  const entries: Record<string, unknown>[] = [];
  setPolicyAuditSink(entry => entries.push(entry));
  try { decide(clean, withReview({ mode: 'enforce' })); }
  finally { setPolicyAuditSink(() => {}); }
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.gate, 'openPr');
  assert.deepEqual(entries[0]?.matches, ['gate:openPr']);
  assert.equal(typeof entries[0]?.fingerprint, 'string');
});

test('develop-complete 门按变更文件数判定，intake 门只记录不拦默认', () => {
  const files = Array.from({ length: 11 }, (_, index) => `src/a${index}.ts`);
  const outcome = decide({ gate: 'develop-complete', repoKey: 'repo', paths: files,
    baseSha: sha, commitSha: 'b'.repeat(40) }, withReview({ mode: 'enforce', limits: { maxFiles: 10, maxChangedLines: 2000 } }));
  assert.equal(outcome?.decision.effect, 'require-approval');
  assert.equal(outcome?.decision.ruleId, 'too-many-files');
  const intake = decide({ gate: 'intake', repoKey: 'repo' }, withReview({ mode: 'enforce' }));
  assert.equal(intake?.decision.effect, 'allow');
  assert.equal(intake?.decision.ruleId, 'gate:intake');
});

test('develop-complete 门要求产生新提交', () => {
  const ok = decide({ gate: 'develop-complete', repoKey: 'repo', baseSha: sha, commitSha: 'b'.repeat(40),
    paths: ['src/a.ts'] }, withReview({ mode: 'enforce' }));
  assert.equal(ok?.decision.effect, 'allow');
  const unchanged = decide({ gate: 'develop-complete', repoKey: 'repo', baseSha: sha, commitSha: sha,
    paths: ['src/a.ts'] }, withReview({ mode: 'enforce' }));
  assert.equal(unchanged?.decision.effect, 'deny');
  assert.equal(unchanged?.decision.ruleId, 'no-new-commit');
});
