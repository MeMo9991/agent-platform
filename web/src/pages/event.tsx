import { useEffect, useState, type FormEvent } from 'react';
import { api, imageUrl } from '../app/api';
import { Badge, Button, Card } from '../components/ui';
import type { Event } from '../shared/types';

function Image({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => { let live = true; let objectUrl = '';
    void imageUrl(path).then(value => { objectUrl = value; if (live) setUrl(value); else URL.revokeObjectURL(value); }).catch(() => {});
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return url ? <img src={url} alt={alt} className="attachment" /> : <p className="muted">图片加载中或不可访问</p>;
}
export function EventPage({ id, repoKeys, canRoute }: { id: string; repoKeys: string[]; canRoute: boolean }) {
  const [event, setEvent] = useState<Event>();
  const [choice, setChoice] = useState('new_task');
  const [taskId, setTaskId] = useState('');
  const [parentTaskId, setParentTaskId] = useState('');
  const [repoKey, setRepoKey] = useState(repoKeys[0] ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [decisionKey, setDecisionKey] = useState(() => crypto.randomUUID());
  useEffect(() => { let live = true;
    const load = () => api<Event>(`/api/events/${encodeURIComponent(id)}`).then(value => { if (live) setEvent(value); })
      .catch(cause => { if (live) setError(String(cause)); });
    void load(); const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [id]);
  async function route(submit: FormEvent) {
    submit.preventDefault(); setError('');
    try {
      const value = await api<{ taskId?: string }>(`/api/events/${encodeURIComponent(id)}/routes`, { method: 'POST',
        body: { choice, reason, idempotencyKey: decisionKey,
          ...(choice === 'existing_task' ? { taskId } : choice === 'new_task' ? { repoKey,
            ...(parentTaskId ? { parentTaskId } : {}) } : {}) } });
      setResult(value.taskId ? `已关联任务 ${value.taskId}` : '路由决定已受理');
      setDecisionKey(crypto.randomUUID());
    } catch (cause) { setError(String(cause)); }
  }
  return <div className="stack detail-page"><a className="back-link" href="#/">← 返回待办</a>{error && <p role="alert" className="error">{error}</p>}
    {!event && !error && <p>正在加载…</p>}
    {event && <><header className="detail-heading"><span className="eyebrow">来源事件 / {event.id}</span><h1>{event.title}</h1>
      <div className="detail-meta"><Badge>{event.status}</Badge><span>{event.sourceId}</span><span>{event.repoKey ?? '仓库待定'}</span></div></header>
      <Card><h2>来源原文</h2><p className="source-text">{event.body}</p>
        {event.taskId && <p>关联任务：<a href={`#/tasks/${encodeURIComponent(event.taskId)}`}>{event.taskId}</a></p>}
        {event.url && /^https?:\/\//i.test(event.url) && <p><a href={event.url} target="_blank" rel="noopener noreferrer">打开来源页面</a></p>}
        {event.attachments.map(image => <Image key={image.id} path={image.imageUrl} alt={`${event.title} 的附件`} />)}</Card>
      {event.status === 'needs_human' && canRoute && <Card><h2>路由复核</h2><p>{event.routing?.reason}</p>
        {event.routing?.candidates.map(item => <p key={item.taskId}>候选任务：<a href={`#/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</a></p>)}
        <form onSubmit={route} className="stack"><label>决定<select value={choice} onChange={change => { setChoice(change.target.value); setDecisionKey(crypto.randomUUID()); }}>
          <option value="new_task">建立新任务</option><option value="existing_task">关联已有任务</option><option value="ignored">忽略事件</option></select></label>
          {choice === 'existing_task' && <label>任务 ID<input value={taskId} onChange={change => { setTaskId(change.target.value); setDecisionKey(crypto.randomUUID()); }} required /></label>}
          {choice === 'new_task' && <label>目标仓库<select value={repoKey} onChange={change => { setRepoKey(change.target.value); setDecisionKey(crypto.randomUUID()); }}>
            {repoKeys.map(key => <option key={key}>{key}</option>)}</select></label>}
          {choice === 'new_task' && <label>关联旧任务（可选）<select value={parentTaskId} onChange={change => {
            setParentTaskId(change.target.value); setDecisionKey(crypto.randomUUID()); }}>
            <option value="">不关联</option>{event.routing?.candidates.map(item =>
              <option key={item.taskId} value={item.taskId}>候选任务 {item.taskId}</option>)}</select></label>}
          <label>理由<textarea value={reason} onChange={change => { setReason(change.target.value); setDecisionKey(crypto.randomUUID()); }} required /></label>
          <Button type="submit">提交决定</Button></form></Card>}
      {result && <p role="status">{result}</p>}</>}
  </div>;
}
