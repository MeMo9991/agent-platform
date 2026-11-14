import { Button as BoardButton, type ButtonProps } from '@/components/base/buttons/button';
import { Chip } from '@/components/base/badges/chip';
import { cx } from '@/utils/cx';
import type { PropsWithChildren } from 'react';

export function Card({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <section className={cx('rounded-3xl border border-border-button-default bg-background-primary-default p-5 shadow-card', className)}>{children}</section>;
}
export function Badge({ children, tone = '' }: PropsWithChildren<{ tone?: string }>) {
  const value = String(children);
  const labels: Record<string, string> = { queued: '排队中', investigating: '调查中', developing: '开发中', verifying: '验证中',
    waiting_human: '等待人工', paused: '已暂停', blocked: '已阻塞', failed: '失败', cancelled: '已取消', completed: '已完成',
    closed: '已关闭', released: '已发布', merged: '已合并', running: '运行中', succeeded: '已成功', passed: '通过',
    needs_human: '待复核', pending: '待处理' };
  const color = tone === 'warn' || ['waiting_human', 'paused', 'blocked'].includes(value) ? 'yellow'
    : ['failed', 'cancelled'].includes(value) ? 'rose'
    : ['closed', 'released', 'merged', 'succeeded', 'completed', 'passed'].includes(value) ? 'lime'
    : ['investigating', 'developing', 'verifying', 'running'].includes(value) ? 'blue' : 'soft';
  return <Chip color={color} variant="caption">{labels[value] ?? children}</Chip>;
}
export function Button(props: ButtonProps) {
  return <BoardButton variant="secondary" size="small" {...props} />;
}
