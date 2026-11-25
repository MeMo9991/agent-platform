import { useEffect, useId, useState, type ReactNode } from 'react';
import { RiAlertLine, RiChat3Line, RiInbox2Line, RiShieldCheckLine } from '@remixicon/react';
import { api } from '../app/api';
import type { Event, RecordItem, Task } from '../shared/types';

type Overview = { pendingEvents: number; runningWorkers: number; enabledSources: number; workerCapacity: number | null };
type InboxNotice = { id: string; title: string; detail: string; checkedAt: string };
type Inbox = { events: Event[]; requests: RecordItem[]; tasks: Task[]; notices?: InboxNotice[] };
const taskStates: Record<string, string> = { failed: '失败', blocked: '受阻', paused: '已暂停', waiting_human: '等待人工' };
const approvalTitles: Record<string, string> = {
  continue: '继续验证审批', functional_review: '功能验证异常审批', manual_delivery: '人工交付审批',
};
const actions: Record<string, string> = { open_pr: '提交 PR', merge: '合并', release: '发布', rollback: '回滚' };
function requestTitle(request: RecordItem) {
  const proposal = request.request;
  if (request.kind === 'question') return 'Agent 提问';
  if (proposal?.action) return `${actions[proposal.action] ?? proposal.action}审批`;
  return approvalTitles[proposal?.kind ?? ''] ?? '范围变更审批';
}

function BoardColumn({ title, count, tone, icon: Icon, children }: {
  title: string; count: number; tone: string; icon: typeof RiAlertLine; children: ReactNode;
}) {
  const heading = useId();
  return <section className="inbox-lane" data-tone={tone} aria-labelledby={heading}>
    <header className="inbox-lane-heading"><Icon aria-hidden /><h2 id={heading}>{title}</h2><span>{count}</span></header>
    {count ? <ul role="list" className="inbox-cards">{children}</ul> : <p className="inbox-lane-empty">暂无{title}</p>}
  </section>;
}

function taskActionsUrl(id: string) {
  return `#/tasks/${encodeURIComponent(id)}/actions`;
}

function BoardCard({ title, meta, label, href }: { title: string; meta: string; label?: string; href?: string }) {
  const content = <>
    <strong dir="auto">{title}</strong><span dir="auto">{meta}</span>
    {label && <span className="inbox-card-label">{label}</span>}
  </>;
  return <li className="inbox-card">
    {href ? <a href={href} className="inbox-card-action">{content}</a>
      : <div className="inbox-card-content">{content}</div>}
  </li>;
}

export function OverviewPage() {
  const [overview, setOverview] = useState<Overview>();
  const [inbox, setInbox] = useState<Inbox>();
  const [error, setError] = useState('');
  useEffect(() => { let live = true;
    const refresh = () => Promise.all([api<Overview>('/api/overview'), api<Inbox>('/api/inbox')])
      .then(([o, i]) => { if (live) { setOverview(o); setInbox(i); setError(''); } })
      .catch(cause => { if (live) setError(String(cause)); });
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const questions = inbox?.requests.filter(request => request.kind === 'question') ?? [];
  const approvals = inbox?.requests.filter(request => request.kind !== 'question') ?? [];
  const taskTitle = new Map(inbox?.tasks.map(task => [task.id, task.title]));
  return <div className="stack overview"><header className="page-heading"><div>
    <h1>待办总览</h1></div>
    <span className="live-indicator"><span /> 每 5 秒更新</span></header>
    {error && <p role="alert" className="error">{error}</p>}
    {!overview && !error && <p>正在加载工作台…</p>}
    {overview && <div className="system-strip">
      <span className="system-dot" aria-hidden /> 系统概况
      <span>来源 {overview.enabledSources} 个已启用</span>
      <span>待路由事件 {overview.pendingEvents} 条</span>
      <span>Worker 使用 {overview.runningWorkers} / {overview.workerCapacity ?? '—'}</span>
    </div>}
    {inbox && <div className="inbox-board">
      <BoardColumn title="待处理事件" count={inbox.events.length + (inbox.notices?.length ?? 0)} tone="events" icon={RiInbox2Line}>
        {inbox.notices?.map(item => <BoardCard key={item.id} title={item.title} meta={item.detail} label="未连接" />)}
        {inbox.events.map(event => <BoardCard key={event.id} title={event.title} meta={event.sourceId}
          href={event.taskId ? taskActionsUrl(event.taskId) : `#/events/${encodeURIComponent(event.id)}`} />)}
      </BoardColumn>
      <BoardColumn title="待回答" count={questions.length} tone="questions" icon={RiChat3Line}>
        {questions.map(request => <BoardCard key={request.id} title={taskTitle.get(request.taskId) ?? requestTitle(request)}
          meta={`任务 ${request.taskId.slice(0, 8)}`} href={taskActionsUrl(request.taskId)} />)}
      </BoardColumn>
      <BoardColumn title="待审批" count={approvals.length} tone="approvals" icon={RiShieldCheckLine}>
        {approvals.map(request => <BoardCard key={request.id} title={requestTitle(request)}
          meta={taskTitle.get(request.taskId) ?? `任务 ${request.taskId.slice(0, 8)}`}
          href={taskActionsUrl(request.taskId)} />)}
      </BoardColumn>
      <BoardColumn title="受阻任务" count={inbox.tasks.length} tone="blocked" icon={RiAlertLine}>
        {inbox.tasks.map(task => <BoardCard key={task.id} title={task.title} meta={task.repoKey}
          label={taskStates[task.state] ?? task.state} href={taskActionsUrl(task.id)} />)}
      </BoardColumn>
    </div>}
  </div>;
}
