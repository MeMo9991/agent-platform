import { useEffect, useState } from 'react';
import { RiAlertLine, RiArrowRightUpLine, RiInbox2Line, RiLoader4Fill, RiPulseLine } from '@remixicon/react';
import { api } from '../app/api';
import { Badge, Card } from '../components/ui';
import type { Event, RecordItem, Task } from '../shared/types';

type Overview = { pendingEvents: number; humanEvents: number; openRequests: number;
  failedTasks: number; runningWorkers: number; queuedRuns: number; enabledSources: number; workerCapacity: number | null };
type Inbox = { events: Event[]; requests: RecordItem[]; tasks: Task[] };
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
  return <div className="stack overview"><header className="page-heading"><div><span className="eyebrow">工作台 / 任务流</span>
    <h1>待办总览</h1><p className="muted">优先处理人的决定，再查看受阻任务与运行队列。</p></div>
    <span className="live-indicator"><span /> 每 5 秒更新</span></header>
    {error && <p role="alert" className="error">{error}</p>}
    {!overview && !error && <p>正在加载工作台…</p>}
    {overview && <><div className="stats">
      <Card className="metric-card metric-people"><div className="metric-top"><span>待人处理</span><RiInbox2Line aria-hidden /></div><strong>{overview.openRequests + overview.humanEvents}</strong><small>事件与审批请求</small></Card>
      <Card className="metric-card metric-blocked"><div className="metric-top"><span>受阻任务</span><RiAlertLine aria-hidden /></div><strong>{overview.failedTasks}</strong><small>失败、阻塞或暂停</small></Card>
      <Card className="metric-card metric-queued"><div className="metric-top"><span>排队运行</span><RiLoader4Fill aria-hidden /></div><strong>{overview.queuedRuns}</strong><small>等待 Worker 处理</small></Card>
      <Card className="metric-card metric-worker"><div className="metric-top"><span>Worker 使用</span><RiPulseLine aria-hidden /></div><strong>{overview.runningWorkers}<em> / {overview.workerCapacity ?? '—'}</em></strong><small>当前运行 / 可用名额</small></Card>
    </div><div className="system-strip"><span className="system-dot" /> 系统概况 <span>来源 {overview.enabledSources} 个已启用</span><span>待路由事件 {overview.pendingEvents} 条</span></div></>}
    <div className="overview-grid"><Card className="queue-card queue-people"><div className="card-heading"><div><span className="eyebrow">人工路由</span><h2>待处理事件</h2></div><a href="#/tasks" aria-label="查看任务列表"><RiArrowRightUpLine aria-hidden /></a></div>
      {inbox?.events.length ? <div className="item-list">{inbox.events.map(event => <a className="item-row" key={event.id} href={`#/events/${encodeURIComponent(event.id)}`}>
        <span className="item-icon"><RiInbox2Line aria-hidden /></span><span className="item-main"><strong>{event.title}</strong><small>{event.sourceId}</small></span><Badge tone="warn">待路由</Badge></a>)}</div>
        : <div className="empty-state"><RiInbox2Line aria-hidden /><strong>没有待处理事件</strong><span>新事件出现后会显示在这里</span></div>}</Card>
      <Card className="queue-card queue-people"><div className="card-heading"><div><span className="eyebrow">人工决定</span><h2>问答与审批</h2></div></div>
      {inbox?.requests.length ? <div className="item-list">{inbox.requests.map(request => <a className="item-row" key={request.id} href={`#/tasks/${encodeURIComponent(request.taskId)}`}>
        <span className="item-icon"><RiPulseLine aria-hidden /></span><span className="item-main"><strong>{request.kind === 'question' ? 'Agent 提问待审查' : request.request?.kind ?? '审批请求'}</strong><small>任务 {request.taskId}</small></span>
        <Badge tone="warn">{request.kind === 'question' ? '待回答' : '待审批'}</Badge></a>)}</div>
        : <div className="empty-state"><RiPulseLine aria-hidden /><strong>暂无人的决定</strong><span>需要回答或审批时会集中展示</span></div>}</Card></div>
    <Card className="queue-card queue-blocked"><div className="card-heading"><div><span className="eyebrow">处理异常</span><h2>受阻任务</h2></div><a href="#/tasks">查看全部任务 →</a></div>
      {inbox?.tasks.length ? <div className="item-list">{inbox.tasks.map(task => <a className="item-row" key={task.id} href={`#/tasks/${encodeURIComponent(task.id)}`}>
        <span className="item-icon"><RiAlertLine aria-hidden /></span><span className="item-main"><strong>{task.title}</strong><small>{task.repoKey} · 更新于 {new Date(task.updatedAt).toLocaleString()}</small></span><Badge>{task.state}</Badge></a>)}</div>
        : <div className="empty-state compact"><RiAlertLine aria-hidden /><strong>没有受阻任务</strong></div>}</Card>
  </div>;
}
