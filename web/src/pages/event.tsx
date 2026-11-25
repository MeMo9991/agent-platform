import { useEffect, useState, type FormEvent } from 'react';
import { RiArrowLeftLine, RiExternalLinkLine, RiImageLine } from '@remixicon/react';
import { Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';
import { Textarea } from '@/components/base/textarea/textarea';
import { api, imageUrl } from '../app/api';
import { Badge, Button, Card } from '../components/ui';
import type { Event, Task } from '../shared/types';

const routeChoices = [
  { value: 'new_task', label: '建立新任务' },
  { value: 'existing_task', label: '关联已有任务' },
  { value: 'ignored', label: '忽略事件' },
] as const;

const routeReasons: Record<string, string> = {
  'Image needs human comparison': '事件包含图片，需要人工判断是否与已有任务重复。',
  'Similar prior Task needs human routing': '发现相似任务，请确认事件归属。',
  'Candidate search was incomplete': '候选任务搜索未完成，请人工确认事件归属。',
  'Source has no trusted matching repository': '系统未能确定事件的目标仓库。',
  'Subscription ownership is ambiguous or out of scope': '已有订阅无法唯一确定事件归属。',
};

function Image({ path, number }: { path: string; number: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let live = true; let objectUrl = '';
    void imageUrl(path).then(value => { objectUrl = value; if (live) setUrl(value); else URL.revokeObjectURL(value); })
      .catch(() => { if (live) setUrl(''); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return <figure className="event-image">
    <div className="event-image-preview">
      {url ? <img src={url} alt={`附件 ${number}`} onError={() => setUrl('')} />
        : <div className="event-image-placeholder"><RiImageLine aria-hidden />
          <span>{url === null ? '正在加载' : '图片不可用'}</span></div>}
    </div>
    <figcaption>附件 {number}</figcaption>
  </figure>;
}
export function EventPage({ id, repoKeys, unverifiedRepoKeys, canRoute, canApprove }: { id: string; repoKeys: string[];
  unverifiedRepoKeys: string[]; canRoute: boolean; canApprove: boolean }) {
  const [event, setEvent] = useState<Event>();
  const [choice, setChoice] = useState<(typeof routeChoices)[number]['value']>('new_task');
  const [ignoreReason, setIgnoreReason] = useState('');
  const [taskId, setTaskId] = useState('');
  const [parentTaskId, setParentTaskId] = useState('');
  const [repoKey, setRepoKey] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [decisionKey, setDecisionKey] = useState(() => crypto.randomUUID());
  const approveInvestigation = choice === 'new_task' && canApprove && event?.investigationApprovalRequired === true;
  const submitLabel = choice === 'ignored' ? '确认忽略' : choice === 'existing_task' ? '确认关联'
    : approveInvestigation ? '建立任务并批准调查' : event?.investigationApprovalRequired ? '建立任务并送审' : '建立任务';
  const allowedRepoKeys = event?.allowedRepoKeys ?? repoKeys;
  const selectedRepoKey = allowedRepoKeys.includes(repoKey) ? repoKey
    : event?.repoKey && allowedRepoKeys.includes(event.repoKey) ? event.repoKey : allowedRepoKeys[0] ?? '';
  const [ownerTasks, setOwnerTasks] = useState<Task[]>([]);
  useEffect(() => { if (choice !== 'existing_task') return; let live = true;
    void api<{ items: Task[] }>(`/api/tasks?limit=50${event?.repoKey ? `&repoKey=${encodeURIComponent(event.repoKey)}` : ''}`)
      .then(value => { if (live) setOwnerTasks(value.items); })
      .catch(() => { if (live) setOwnerTasks([]); });
    return () => { live = false; };
  }, [choice, event?.repoKey]);
  const eligibleOwners = ownerTasks.filter(task => !['released', 'closed', 'cancelled'].includes(task.state) &&
    task.mandate.allowedActions.includes('investigate'));
  useEffect(() => { let live = true;
    const load = () => api<Event>(`/api/events/${encodeURIComponent(id)}`).then(value => { if (live) setEvent(value); })
      .catch(cause => { if (live) setError(String(cause)); });
    void load(); const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [id]);
  async function route(submit: FormEvent) {
    submit.preventDefault(); setError(''); setSubmitting(true);
    try {
      const value = await api<{ taskId?: string; event?: Event }>(`/api/events/${encodeURIComponent(id)}/routes`, { method: 'POST',
        body: { choice, reason: choice === 'ignored' ? ignoreReason.trim() : '人工路由', idempotencyKey: decisionKey,
          ...(choice === 'existing_task' ? { taskId } : choice === 'new_task' ? { repoKey: selectedRepoKey,
            ...(parentTaskId ? { parentTaskId } : {}), ...(approveInvestigation ? { approveInvestigation } : {}) } : {}) } });
      setResult(choice === 'ignored' ? '已忽略事件' :
        approveInvestigation ? '已建立任务并批准调查' : choice === 'new_task' && event?.investigationApprovalRequired
          ? '已建立任务，等待调查审批' : value.taskId ? `已关联任务 ${value.taskId}` : '路由决定已受理');
      if (value.event) setEvent(value.event);
      setDecisionKey(crypto.randomUUID());
    } catch (cause) { setError(String(cause)); }
    finally { setSubmitting(false); }
  }
  const reason = event?.routing?.reason;
  return <div className="stack detail-page event-page">
    <a className="back-link event-back" href="#/"><RiArrowLeftLine aria-hidden />返回待办</a>
    {error && <p role="alert" className="error">{error}</p>}
    {!event && !error && <p>正在加载…</p>}
    {event && <><header className="event-heading">
      <Badge tone={event.status === 'needs_human' ? 'warn' : ''}>{event.status}</Badge>
      <TooltipTrigger>
        <Focusable><h1>{event.title}</h1></Focusable>
        <Tooltip className="text-preview-tooltip" aria-hidden="true">{event.title}</Tooltip>
      </TooltipTrigger>
      <div className="event-meta">
        <span>{event.sourceId}</span><span>{event.repoKey ?? '仓库待定'}
          {event.repositorySelection && <small>{event.repositorySelection === 'default' ? '默认主仓库' :
            event.repositorySelection === 'repository-name' ? '按仓库名匹配' : '按代码文件名匹配'}</small>}</span>
      </div>
    </header>
    {result && <p role="status" className="event-review-result">{result}</p>}
    <div className="event-review-layout">
      <Card className="event-source">
        <div className="event-section-heading"><h2>来源原文</h2>
          {event.url && /^https?:\/\//i.test(event.url) &&
            <a href={event.url} target="_blank" rel="noopener noreferrer">打开来源<RiExternalLinkLine aria-hidden /></a>}
        </div>
        <p className="source-text event-body">{event.body.trim() ? event.body : '暂无来源正文'}</p>
        {event.taskId && <p>关联任务：<a href={`#/tasks/${encodeURIComponent(event.taskId)}`}>{event.taskId}</a></p>}
        {event.attachments.length > 0 && <div className="event-attachments">
          <h3>附件 <span>{event.attachments.length}</span></h3>
          <div className="event-image-grid">{event.attachments.map((image, index) =>
            <Image key={image.imageUrl} path={image.imageUrl} number={index + 1} />)}</div>
        </div>}
      </Card>
      {event.status === 'needs_human' && canRoute && <Card className="event-review-panel">
        <h2>路由复核</h2>
        {reason && <p className="event-review-reason">{routeReasons[reason] ?? reason}</p>}
        {event.routing?.candidates.map(item => <p key={item.taskId}>候选任务：<a href={`#/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</a></p>)}
        <form onSubmit={route} className="event-route-form">
          <fieldset className="event-route-options"><legend>处理方式</legend>
            {routeChoices.map(option => <label key={option.value} className="event-route-option">
              <span><input type="radio" name="route" value={option.value} checked={choice === option.value}
                onChange={() => { setChoice(option.value); setDecisionKey(crypto.randomUUID()); }} /></span>
              {option.label}
            </label>)}
          </fieldset>
          {choice === 'existing_task' && <label>关联任务<select value={taskId} onChange={change => { setTaskId(change.target.value); setDecisionKey(crypto.randomUUID()); }} required>
            <option value="">选择允许调查且未关闭的任务</option>{eligibleOwners.map(task =>
              <option key={task.id} value={task.id}>{task.title}（{task.state}）</option>)}</select>
            {!eligibleOwners.length && <span>没有可作为归属的任务</span>}</label>}
          {choice === 'new_task' && <label>目标仓库<select value={selectedRepoKey} onChange={change => { setRepoKey(change.target.value); setDecisionKey(crypto.randomUUID()); }}>
            {allowedRepoKeys.map(key => <option key={key}>{key}</option>)}</select>
            {!allowedRepoKeys.length && <span>项目组尚未配置可用仓库</span>}</label>}
          {choice === 'new_task' && unverifiedRepoKeys.includes(selectedRepoKey) &&
            <p role="status" className="event-review-warning">此仓库无法自动校验。开发完成后将等待人工审批和交付。</p>}
          {choice === 'new_task' && <label>关联旧任务（可选）<select value={parentTaskId} onChange={change => {
            setParentTaskId(change.target.value); setDecisionKey(crypto.randomUUID()); }}>
            <option value="">不关联</option>{event.routing?.candidates.map(item =>
              <option key={item.taskId} value={item.taskId}>候选任务 {item.taskId}</option>)}</select></label>}
          {choice === 'ignored' && <Textarea label="忽略原因" value={ignoreReason} maxLength={500} rows={3}
            onChange={value => { setIgnoreReason(value); setDecisionKey(crypto.randomUUID()); }} />}
          <div className="event-review-submit"><Button type="submit" variant="primary" disabled={submitting ||
            (choice === 'new_task' && !allowedRepoKeys.length) || (choice === 'existing_task' && !taskId) ||
            (choice === 'ignored' && !ignoreReason.trim())}>{submitting ? '提交中…' : submitLabel}</Button></div>
        </form>
      </Card>}
    </div>
    <p className="event-identifier">事件 ID <code>{event.id}</code></p></>}
  </div>;
}
