import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../app/api';
import { Badge, Button, Card } from '../components/ui';
import type { Detail, RecordItem } from '../shared/types';

function ContentReview({ taskId, version, targetKind, targetId, onDone }: { taskId: string; version: number;
  targetKind: 'question' | 'result' | 'review'; targetId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  async function publish(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/content-reviews`, { method: 'POST',
        body: { expectedVersion: version, targetKind, targetId, text, idempotencyKey: key } });
      onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <form className="stack content-review" onSubmit={publish}>
    <p className="muted">{targetKind === 'question' ? '题目' : targetKind === 'review' ? 'Agent 审查意见' : 'Agent 结论'}待审查。请核对原生会话后，填写可在任务页展示的文字。</p>
    <label>审查后内容<textarea value={text} onChange={event => { setText(event.target.value); setKey(crypto.randomUUID()); }}
      required maxLength={8192} placeholder="填写已核对且不含凭据或本机路径的内容" /></label>
    <Button type="submit" disabled={busy || !text.trim()}>{busy ? '发布中…' : '发布审查内容'}</Button>
    {error && <p role="alert" className="error">{error.includes('version') ? '任务已更新，请刷新后重试' : error}</p>}
  </form>;
}

function ReviewFindingPublication({ taskId, version, review, index, onDone }: { taskId: string; version: number;
  review: RecordItem; index: number; onDone: () => void }) {
  const [finding, setFinding] = useState({ file: '', severity: '', evidence: '', impact: '', action: '', verificationMethod: '' });
  const [line, setLine] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function publish(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/review-findings`, { method: 'POST',
        body: { expectedVersion: version, reviewRecordId: review.id, findingIndex: index,
          subjectSha: review.subjectSha, ...finding, ...(line ? { line: Number(line) } : {}), idempotencyKey: key } });
      onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <form className="stack content-review" onSubmit={publish}>
    <p className="muted">请核对原生审查记录中意见 #{index + 1} 的文件、证据和影响，再发布供批准人处理。</p>
    {(['file', 'severity', 'evidence', 'impact', 'action', 'verificationMethod'] as const).map(field =>
      <label key={field}>{({ file: '文件', severity: '严重度', evidence: '证据', impact: '影响', action: '建议处理',
        verificationMethod: '验证方法' })[field]}
        <textarea value={finding[field]} required={['file', 'severity', 'evidence', 'impact'].includes(field)}
          maxLength={field === 'file' ? 500 : field === 'severity' ? 40 : field === 'evidence' || field === 'impact' ? 4000 : 2000}
          onChange={event => { setFinding(value => ({ ...value, [field]: event.target.value })); setKey(crypto.randomUUID()); }} />
      </label>)}
    <label>行号（可选）<input type="number" min="1" step="1" value={line}
      onChange={event => { setLine(event.target.value); setKey(crypto.randomUUID()); }} /></label>
    <Button type="submit" disabled={busy || !finding.file.trim() || !finding.severity.trim() ||
      !finding.evidence.trim() || !finding.impact.trim()}>{busy ? '发布中…' : '发布这条意见'}</Button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}

function ReviewResolution({ taskId, version, review, index, onDone }: { taskId: string; version: number;
  review: RecordItem; index: number; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [disposition, setDisposition] = useState<'accept_risk' | 'false_positive'>('false_positive');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/review-resolutions`, { method: 'POST',
        body: { expectedVersion: version, reviewRecordId: review.id, findingIndex: index,
          subjectSha: review.subjectSha, disposition, reason, idempotencyKey: key } });
      onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={submit}><label>处理决定<select value={disposition}
    onChange={event => { setDisposition(event.target.value as typeof disposition); setKey(crypto.randomUUID()); }}>
    <option value="false_positive">误报</option><option value="accept_risk">接受风险</option></select></label>
    <label>理由<textarea value={reason} onChange={event => { setReason(event.target.value); setKey(crypto.randomUUID()); }}
      required maxLength={2000} /></label><Button type="submit" disabled={busy || !reason.trim()}>记录处理决定</Button>
    {error && <p role="alert" className="error">{error}</p>}</form>;
}

function HumanAction({ taskId, version, record, onDone }: { taskId: string; version: number;
  record: RecordItem; onDone: () => void }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisionKey, setDecisionKey] = useState(() => crypto.randomUUID());
  const isQuestion = record.kind === 'question';
  async function submit(event: FormEvent, approval?: 'approve' | 'reject') {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/${isQuestion ? 'answers' : 'approvals'}`,
        { method: 'POST', body: { expectedVersion: version, value: isQuestion
          ? { questionId: record.id, content, idempotencyKey: decisionKey }
          : { requestId: record.request?.id ?? record.id, decision: approval, idempotencyKey: decisionKey } } });
      onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="action-box"><p><strong>{isQuestion ? '待回答' : '待审批'}</strong> · {record.prompt ?? record.request?.kind ?? '题目待审查'}</p>
    {record.request && <p className="muted">受审 SHA：{record.request.sourceSha} · 拟议动作：{record.request.action ?? record.request.proposedMandate?.allowedActions.join(', ')}
      {record.request.targetBranch && <> · 目标分支：{record.request.targetBranch}</>}
      {record.request.proposedMandate?.maxAutoRisk && <> · 自动执行风险上限：{record.request.proposedMandate.maxAutoRisk}</>}
      {record.request.targetSha && <> · 目标 SHA：{record.request.targetSha}</>}
      {record.request.changeRef && <> · 变更请求：{record.request.changeRef}</>}
      {record.request.reviewRecordId && <> · 审查记录：{record.request.reviewRecordId}</>}
      {record.request.policyVersion && <> · 策略版本：{record.request.policyVersion}</>}</p>}
    {isQuestion && !record.prompt && <ContentReview taskId={taskId} version={version} targetKind="question" targetId={record.id} onDone={onDone} />}
    {isQuestion ? record.prompt && <form onSubmit={submit} className="stack"><label>回答<textarea value={content} onChange={event => { setContent(event.target.value); setDecisionKey(crypto.randomUUID()); }} required /></label>
      <Button type="submit" disabled={busy}>提交回答</Button></form> : <div className="actions">
      <Button variant="primary" disabled={busy} onClick={event => void submit(event, 'approve')}>批准</Button>
      <Button disabled={busy} onClick={event => void submit(event, 'reject')}>驳回</Button></div>}
    {error && <p role="alert" className="error">{error.includes('version') ? '任务已更新，请刷新后重新决定' : error}</p>}</div>;
}

function Commands({ detail, actorId, onDone }: { detail: Detail; actorId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [split, setSplit] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [busy, setBusy] = useState(false);
  const commandKeys = useRef<Record<string, string>>({});
  const [splitKey, setSplitKey] = useState(() => crypto.randomUUID());
  const [takeoverSummary, setTakeoverSummary] = useState('');
  const [takeoverDisposition, setTakeoverDisposition] = useState<'resume' | 'cancel'>('resume');
  const [codeChange, setCodeChange] = useState<'none' | 'committed'>('none');
  const [commitSha, setCommitSha] = useState('');
  const [takeoverKey, setTakeoverKey] = useState(() => crypto.randomUUID());
  async function command(kind: 'pause' | 'resume' | 'retry' | 'cancel' | 'takeover') {
    setError(''); setReceipt(''); setBusy(true);
    try {
      const key = commandKeys.current[kind] ??= crypto.randomUUID();
      const result = await api<{ version: number }>(`/api/tasks/${encodeURIComponent(detail.task.id)}/commands`,
        { method: 'POST', body: { kind, reason, expectedVersion: detail.task.version, idempotencyKey: key } });
      delete commandKeys.current[kind];
      setReceipt(`命令已记录，任务版本 ${result.version}`); onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function doSplit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await api<{ eventId: string }>(`/api/tasks/${encodeURIComponent(detail.task.id)}/split`,
        { method: 'POST', body: { description: split, expectedVersion: detail.task.version, idempotencyKey: splitKey } });
      setReceipt(`拆分事件已受理：${result.eventId}`); setSplit(''); setSplitKey(crypto.randomUUID()); onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function finishTakeover(event: FormEvent) {
    event.preventDefault(); setError(''); setReceipt(''); setBusy(true);
    try {
      const result = await api<{ version: number }>(`/api/tasks/${encodeURIComponent(detail.task.id)}/takeover-result`,
        { method: 'POST', body: { expectedVersion: detail.task.version, summary: takeoverSummary,
          disposition: takeoverDisposition, codeChange: takeoverDisposition === 'cancel' ? 'none' : codeChange,
          ...(takeoverDisposition === 'resume' && codeChange === 'committed' ? { commitSha } : {}),
          idempotencyKey: takeoverKey } });
      setReceipt(`接管结果已记录，任务版本 ${result.version}`); setTakeoverSummary('');
      setCodeChange('none'); setCommitSha('');
      setTakeoverKey(crypto.randomUUID()); onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <Card><h2>任务操作</h2><label>原因<input value={reason} onChange={event => { setReason(event.target.value); commandKeys.current = {}; }} required placeholder="说明操作原因" /></label>
    {!detail.task.owner && <div className="actions">{(['pause','resume','retry','cancel','takeover'] as const).map(kind =>
      <Button key={kind} disabled={busy || !reason.trim()} onClick={() => void command(kind)}>{({ pause:'暂停', resume:'恢复', retry:'重试', cancel:'取消', takeover:'人工接管' })[kind]}</Button>)}</div>
    }
    {detail.task.state === 'paused' && detail.task.owner === actorId && <form onSubmit={finishTakeover} className="stack">
      <h3>提交接管结果</h3><label>处理摘要<textarea value={takeoverSummary}
        onChange={event => { setTakeoverSummary(event.target.value); setTakeoverKey(crypto.randomUUID()); }} required maxLength={2000} /></label>
      <label>后续处理<select value={takeoverDisposition} onChange={event => {
        setTakeoverDisposition(event.target.value as 'resume' | 'cancel'); setTakeoverKey(crypto.randomUUID()); }}>
        <option value="resume">恢复 Agent</option><option value="cancel">取消任务</option></select></label>
      {takeoverDisposition === 'resume' && <><label>代码结果<select value={codeChange} onChange={event => {
        setCodeChange(event.target.value as 'none' | 'committed'); setTakeoverKey(crypto.randomUUID()); }}>
        <option value="none">未改代码，继续原阶段</option><option value="committed">已提交代码，核验后进入验证</option></select></label>
        {codeChange === 'committed' && <label>人工提交 SHA<input value={commitSha} onChange={event => {
          setCommitSha(event.target.value.trim()); setTakeoverKey(crypto.randomUUID()); }}
          required pattern="[a-f0-9]{40}" placeholder="40 位 Git 提交 SHA" /></label>}</>}
      <Button type="submit" disabled={busy}>记录结果</Button></form>}
    {detail.task.owner && detail.task.owner !== actorId && <p className="muted">由 {detail.task.owner} 接管中</p>}
    <form onSubmit={doSplit} className="stack"><label>拆分为关联任务<textarea value={split} onChange={event => { setSplit(event.target.value); setSplitKey(crypto.randomUUID()); }}
      required placeholder="描述独立问题或新增范围" /></label><Button type="submit" disabled={busy}>提交拆分事件</Button></form>
    {error && <p role="alert" className="error">{error.includes('version') ? '任务已更新，请刷新后重新决定' : error}</p>}
    {receipt && <p role="status">{receipt}</p>}</Card>;
}

export function TaskDetailPage({ id, actorId, roles, stage5WritesEnabled }: { id: string; actorId: string;
  roles: string[]; stage5WritesEnabled: boolean }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [hostResult, setHostResult] = useState('');
  const [hostBusy, setHostBusy] = useState(false);
  async function prepareOpenChange() {
    if (!detail) return;
    setHostBusy(true); setHostResult('');
    try {
      const result = await api<{ kind: 'scope_request' | 'action_request' | 'ready'; targetSha: string }>(
        `/api/tasks/${encodeURIComponent(id)}/open-change/prepare`,
        { method: 'POST', body: { expectedVersion: detail.task.version } });
      setHostResult(result.kind === 'scope_request' ? `已请求范围审批，目标 SHA ${result.targetSha}`
        : result.kind === 'action_request' ? `已请求动作审批，目标 SHA ${result.targetSha}`
          : `动作批准有效，目标 SHA ${result.targetSha}`);
      setRevision(value => value + 1);
    } catch (cause) { setHostResult(String(cause)); }
    finally { setHostBusy(false); }
  }
  async function executeOpenChange() {
    if (!detail) return;
    setHostBusy(true); setHostResult('');
    try {
      const result = await api<{ kind: 'opened' | 'uncertain'; changeId?: string }>(
        `/api/tasks/${encodeURIComponent(id)}/open-change/execute`,
        { method: 'POST', body: { expectedVersion: detail.task.version } });
      setHostResult(result.kind === 'opened' ? `变更请求 ${result.changeId} 已由平台确认`
        : '外部状态未确认；系统不会重复创建，请核对平台');
      setRevision(value => value + 1);
    } catch (cause) { setHostResult(String(cause)); }
    finally { setHostBusy(false); }
  }
  async function refreshCodeHost() {
    setHostBusy(true); setHostResult('');
    try {
      const result = await api<{ ready: boolean; state: string; targetSha: string }>(
        `/api/tasks/${encodeURIComponent(id)}/code-host/status`);
      setHostResult(`平台状态：${result.state} · 目标 SHA ${result.targetSha} · 门禁${result.ready ? '通过' : '未通过'}`);
      setRevision(value => value + 1);
    } catch (cause) { setHostResult(String(cause)); }
    finally { setHostBusy(false); }
  }
  async function prepareMerge() {
    if (!detail) return;
    setHostBusy(true); setHostResult('');
    try {
      const result = await api<{ kind: 'scope_request' | 'action_request' | 'manual_ready';
        targetSha: string; changeId: string }>(`/api/tasks/${encodeURIComponent(id)}/merge/prepare`,
        { method: 'POST', body: { expectedVersion: detail.task.version } });
      setHostResult(result.kind === 'scope_request' ? `已请求合并范围审批，变更请求 ${result.changeId}`
        : result.kind === 'action_request' ? `已请求合并动作审批，目标 SHA ${result.targetSha}`
          : `合并审批与检查通过；请在平台人工合并变更请求 ${result.changeId}，并确认目标 SHA ${result.targetSha}`);
      setRevision(value => value + 1);
    } catch (cause) { setHostResult(String(cause)); }
    finally { setHostBusy(false); }
  }
  async function observeMerge() {
    if (!detail) return;
    setHostBusy(true); setHostResult('');
    try {
      const result = await api<{ state: 'pending' | 'merged' }>(
        `/api/tasks/${encodeURIComponent(id)}/merge/observe`,
        { method: 'POST', body: { expectedVersion: detail.task.version } });
      setHostResult(result.state === 'merged' ? '平台合并回执已核实，等待发布'
        : '平台尚未确认合并');
      setRevision(value => value + 1);
    } catch (cause) { setHostResult(String(cause)); }
    finally { setHostBusy(false); }
  }
  useEffect(() => { let live = true;
    const load = () => api<Detail>(`/api/tasks/${encodeURIComponent(id)}`).then(value => {
      if (live) { setDetail(value); setError(''); }
    }).catch(cause => { if (live) setError(String(cause)); });
    void load(); const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [id, revision]);
  const ci = detail?.records.filter(item => item.kind === 'ci').at(-1);
  const mergedSha = detail?.records.filter(item => item.kind === 'effect' && item.action === 'merge' &&
    item.receipt?.merged).at(-1)?.receipt?.mergedSha;
  return <div className="stack detail-page"><a className="back-link" href="#/tasks">← 返回任务列表</a>{error && <p role="alert" className="error">{error}</p>}
    {!detail && !error && <p>正在加载…</p>}
    {detail && <><header className="detail-heading"><span className="eyebrow">任务 / {detail.task.id}</span>
      <h1>{detail.task.title}</h1><div className="detail-meta"><Badge>{detail.task.state}</Badge>
      <span>{detail.task.repoKey}</span><span>第 {detail.task.iteration} 轮</span><span>版本 {detail.task.version}</span></div></header>
      <Card className="task-summary"><div className="card-heading"><div><span className="eyebrow">任务边界</span><h2>当前范围与授权</h2></div></div>
        <div className="detail-grid"><div><small>任务范围</small><p>{detail.task.scope}</p></div><div><small>目标</small><p>{detail.task.mandate.goal}</p></div></div>
        <div className="detail-foot">许可动作：{detail.task.mandate.allowedActions.join('、')} <span>策略：{detail.task.mandate.policyVersion}</span></div></Card>
      <Card><h2>来源</h2>{detail.events.length ? detail.events.map(event => <p key={event.id}>
        <a href={`#/events/${encodeURIComponent(event.id)}`}>{event.title}</a> <Badge>{event.status}</Badge></p>)
        : <p className="muted">尚无来源记录</p>}</Card>
      <Card><h2>待决定事项</h2>{detail.records.filter(item => item.status === 'open' && ['question','approval_request'].includes(item.kind)).length
        ? detail.records.filter(item => item.status === 'open' && ['question','approval_request'].includes(item.kind)).map(item =>
          (item.kind === 'question' ? roles.includes('answer') : roles.includes('approve'))
            ? <HumanAction key={item.id} taskId={id} version={detail.task.version} record={item} onDone={() => setRevision(value => value + 1)} />
            : <p key={item.id}>{item.prompt ?? item.request?.kind} · 当前凭据无决定权限</p>)
        : <p className="muted">暂无待决定事项</p>}</Card>
      <Card><h2>运行与会话</h2>{detail.runs.length ? detail.runs.map(run => <div className="run-row" key={run.id}>
        <Badge>{run.status}</Badge> <strong>{run.stage}</strong> · {run.agentKind ?? 'Agent 待定'}
        {run.sessionId && <> · Session {run.sessionId} <Button onClick={() => void navigator.clipboard.writeText(run.sessionId!)}>复制引用</Button></>}
        {run.commitSha && <> · SHA {run.commitSha}</>}
        {run.skillRef && <> · Skill {run.skillRef.path}@{run.skillRef.commitSha}</>}
        {run.conclusion && <p className="source-text"><strong>Agent 结论：</strong>{run.conclusion}</p>}
        {run.hasResult && !run.conclusion && (roles.includes('command')
          ? <ContentReview taskId={id} version={detail.task.version} targetKind="result" targetId={run.id}
              onDone={() => setRevision(value => value + 1)} />
          : <p className="muted">结果已保存，结论待人工审查</p>)}
      </div>) : <p className="muted">尚无运行</p>}</Card>
      <Card><h2>开发证据</h2>{detail.records.some(item => item.kind === 'development' || item.kind === 'check')
        ? detail.records.filter(item => item.kind === 'development' || item.kind === 'check').map(item =>
          <div className="run-row" key={item.id}>{item.kind === 'development' ? <>
            <strong>提交 {item.commitSha}</strong><p className="muted">基线 {item.baseSha} · 提交后复核：{item.postCheckVerified ? '通过' : item.postCheckError ?? '未通过'}</p>
            <p>Diff 记录 {item.diff?.recordId} · {item.diff?.sha256 ? `SHA-256 ${item.diff.sha256} · ${item.diff.bytes} 字节`
              : item.diff?.truncated ? '文件超过预览上限' : '文件暂不可读取'}</p></> : <>
            <strong>检查 {item.result}</strong><p>{[item.command, ...(item.args ?? [])].filter(Boolean).join(' ')}</p>
            <p className="muted">受审 SHA {item.subjectSha} · 退出码 {item.exitCode ?? '未知'} · 终止确认：{item.terminationConfirmed ? '是' : '否'}</p>
            <p>日志记录 {item.log?.recordId} · {item.log?.sha256 ? `SHA-256 ${item.log.sha256} · ${item.log.bytes} 字节`
              : item.log?.truncated ? '文件超过预览上限' : '文件暂不可读取'}</p></>}</div>)
        : <p className="muted">尚无开发证据</p>}</Card>
      <Card><h2>事实时间线</h2>{detail.records.length ? <ol className="timeline">{detail.records.map(item =>
        <li key={item.id}><time>{new Date(item.at).toLocaleString()}</time> <Badge>{item.kind}</Badge>
          <p>{item.prompt ?? item.summary ?? item.reason ?? item.content ?? item.result ?? item.status ?? item.decision ?? item.commitSha ?? item.id}</p>
          {item.kind === 'human_result' && item.commitSha && <p className="muted">人工提交 SHA {item.commitSha} · 开发证据记录 {item.developmentRecordId}</p>}
          {item.subjectSha && <p className="muted">SHA {item.subjectSha}</p>}</li>)}</ol>
        : <p className="muted">尚无记录</p>}</Card>
      <Card><h2>独立审查</h2>{detail.records.filter(item => item.kind === 'review').length
        ? detail.records.filter(item => item.kind === 'review').map(item => <div className="run-row" key={item.id}>
          <strong>{item.verdict === 'pass' ? '通过' : '阻断'} · SHA {item.subjectSha}</strong>
          {item.summary ? <p>{item.summary}</p> : roles.includes('command')
            ? <ContentReview taskId={id} version={detail.task.version} targetKind="review" targetId={item.id}
                onDone={() => setRevision(value => value + 1)} />
            : <p className="muted">意见正文待人工审查</p>}
          {item.verdict === 'block' && item.findingCount === 0 && <p className="muted">审查未给出具体意见；请在任务操作中填写原因并重试审查。</p>}
          {Array.from({ length: item.findingCount ?? 0 }, (_, index) => {
            const published = detail.records.find(record => record.kind === 'review_finding_publication' &&
              record.reviewRecordId === item.id && record.findingIndex === index && record.subjectSha === item.subjectSha);
            const resolved = detail.records.some(record => record.kind === 'review_resolution' &&
              record.reviewRecordId === item.id && record.findingIndex === index);
            const current = detail.task.state === 'waiting_human' &&
              item.id === detail.records.filter(record => record.kind === 'review').at(-1)?.id;
            return <div key={index}><p>意见 #{index + 1} · 审查记录 {item.id}</p>
              {published ? <div><p>{published.file}{published.line ? `:${published.line}` : ''} · {published.severity}</p>
                <p>证据：{published.evidence}</p><p>影响：{published.impact}</p>
                {published.action && <p>建议处理：{published.action}</p>}
                {published.verificationMethod && <p>验证方法：{published.verificationMethod}</p>}
                <p className="muted">人工核对：{published.reviewer} · SHA {published.subjectSha}</p></div>
                : current && roles.includes('command')
                  ? <ReviewFindingPublication taskId={id} version={detail.task.version} review={item} index={index}
                      onDone={() => setRevision(value => value + 1)} />
                  : <p className="muted">该条意见尚未人工核对发布</p>}
              {resolved ? <p className="muted">已有结构化处理决定</p>
                : published && current && roles.includes('approve') &&
                  <ReviewResolution taskId={id} version={detail.task.version} review={item} index={index}
                    onDone={() => setRevision(value => value + 1)} />}</div>;
          })}
        </div>) : <p className="muted">尚无结果</p>}</Card>
      <Card><h2>CI 与合并</h2>{detail.task.state === 'ready_to_merge' && roles.includes('command') &&
        <Button disabled={hostBusy} onClick={() => void prepareOpenChange()}>
          {hostBusy ? '检查中…' : '发起 PR/MR 审批'}</Button>}
        {stage5WritesEnabled && detail.task.state === 'ready_to_merge' && roles.includes('command') &&
          <Button disabled={hostBusy} onClick={() => void executeOpenChange()}>创建已批准的 PR/MR</Button>}
        {detail.records.some(item => item.kind === 'effect' && item.status === 'done') &&
          <Button disabled={hostBusy} onClick={() => void refreshCodeHost()}>刷新平台检查</Button>}
        {ci?.ready && detail.task.state === 'ready_to_merge' && roles.includes('command') &&
          <Button disabled={hostBusy} onClick={() => void prepareMerge()}>发起合并审批</Button>}
        {detail.records.some(item => item.kind === 'effect' && item.action === 'merge' &&
          ['pending', 'uncertain'].includes(item.status ?? '')) && roles.includes('command') &&
          <Button disabled={hostBusy} onClick={() => void observeMerge()}>核验人工合并回执</Button>}
        {hostResult && <p role="status">{hostResult}</p>}
        {ci ? <div className="run-row"><strong>变更请求 {ci.changeId} · {ci.state} · 门禁{ci.ready ? '通过' : '未通过'}</strong>
            <p className="muted">源 SHA {ci.subjectSha} · 目标 SHA {ci.targetSha} · 平台状态 {ci.gate}</p>
            <p>必需检查：{ci.requiredChecks?.join('、') || '未确认'}</p>
            {ci.checks?.map((check, index) => <p key={index}>{check.name} · {check.status} · {check.conclusion} · {check.commitSha}</p>)}
          </div> : <p className="muted">尚无平台检查或合并回执</p>}
        {mergedSha && <p>已核实合并提交：{mergedSha}</p>}</Card>
      {roles.includes('command') && <Commands detail={detail} actorId={actorId} onDone={() => setRevision(value => value + 1)} />}
    </>}
  </div>;
}
