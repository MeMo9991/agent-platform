import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RiCloseLine, RiEditLine, RiFileCopyLine, RiPauseLine, RiPlayLine, RiRefreshLine, RiRestartLine, RiUserLine } from '@remixicon/react';
import { api } from '../app/api';
import { Badge, Button, Card } from '../components/ui';
import { Chip } from '@/components/base/badges/chip';
import { Tab, TabList, TabPanel, Tabs } from '@/components/base/tabs/tabs';
import type { Detail, RecordItem, Run } from '../shared/types';
import { canInterruptTask } from '../shared/task-command-availability';

function QuestionReview({ taskId, version, targetId, onDone }: { taskId: string; version: number;
  targetId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  async function publish(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/content-reviews`, { method: 'POST',
        body: { expectedVersion: version, targetKind: 'question', targetId, text, idempotencyKey: key } });
      onDone();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <form className="stack content-review" onSubmit={publish}>
    <p className="muted">Agent 问题待审查。请核对原生会话后，填写可在任务页展示的文字。</p>
    <label>审查后内容<textarea value={text} onChange={event => { setText(event.target.value); setKey(crypto.randomUUID()); }}
      required maxLength={8192} placeholder="填写已核对且不含凭据或本机路径的内容" /></label>
    <Button type="submit" variant="primary" disabled={busy || !text.trim()}>{busy ? '发布中…' : '发布待回答问题'}</Button>
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
    <Button type="submit" variant="primary" disabled={busy || !finding.file.trim() || !finding.severity.trim() ||
      !finding.evidence.trim() || !finding.impact.trim()}>{busy ? '发布中…' : '发布这条意见'}</Button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}

function ReviewResolution({ taskId, version, review, index, onDone }: { taskId: string; version: number;
  review: RecordItem; index: number; onDone: () => void }) {
  const [disposition, setDisposition] = useState<'accept_risk' | 'false_positive'>('false_positive');
  const [reason, setReason] = useState('');
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

function PublishedFinding({ finding }: { finding: RecordItem }) {
  return <dl className="task-run-meta">
    <div><dt>文件</dt><dd><code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code></dd></div>
    <div><dt>严重度</dt><dd>{finding.severity}</dd></div>
    <div className="task-review-wide"><dt>证据</dt><dd>{finding.evidence}</dd></div>
    <div className="task-review-wide"><dt>影响</dt><dd>{finding.impact}</dd></div>
    {finding.action && <div className="task-review-wide"><dt>建议处理</dt><dd>{finding.action}</dd></div>}
    {finding.verificationMethod && <div className="task-review-wide"><dt>验证方法</dt><dd>{finding.verificationMethod}</dd></div>}
    <div><dt>人工核对</dt><dd>{finding.reviewer}</dd></div>
    <div><dt>受审 SHA</dt><dd><code>{finding.subjectSha}</code></dd></div>
  </dl>;
}

function ReviewStageDetails({ review, records, nextRun }: { review: RecordItem;
  records: RecordItem[]; nextRun?: Run }) {
  return <details className="task-stage-details" open={review.verdict === 'block'}>
    <summary>审查详情 · {review.verdict === 'pass' ? '通过' : '阻断'} · {review.findingCount ?? 0} 条意见</summary>
    <dl className="task-run-meta"><div><dt>受审 SHA</dt><dd><code>{review.subjectSha}</code></dd></div>
      <div><dt>审查记录</dt><dd><code>{review.id}</code></dd></div></dl>
    {review.summary && <p className="task-review-summary source-text">{review.summary}</p>}
    {Array.from({ length: review.findingCount ?? 0 }, (_, index) => {
      const published = records.find(record => record.kind === 'review_finding_publication' &&
        record.reviewRecordId === review.id && record.findingIndex === index && record.subjectSha === review.subjectSha);
      const resolved = records.some(record => record.kind === 'review_resolution' &&
        record.reviewRecordId === review.id && record.findingIndex === index);
      return <div className="task-review-finding" key={index}><h3>意见 #{index + 1}</h3>
        {published ? <PublishedFinding finding={published} /> : <p className="muted">意见内容待人工核对后展示</p>}
        {resolved && <p className="muted">已有结构化处理决定</p>}
      </div>;
    })}
    {review.verdict === 'block' && <p className="muted">{nextRun?.stage === 'develop'
      ? '已排队返回 develop 修复；后续 Run 显示在下方。'
      : review.findingCount === 0 ? '阻断意见为空，需在待处理页人工重试审查。'
        : '自动修复未继续时，请在待处理页查看人工操作。'}</p>}
  </details>;
}

export function HumanAction({ taskId, version, record, onDone }: { taskId: string; version: number;
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
  const actionLabels: Record<string, string> = { open_pr: '提交 PR', merge: '合并',
    release: '发布', rollback: '回滚' };
  const action = record.request?.action;
  const actionText = action ? actionLabels[action] ?? action
    : record.request?.proposedMandate?.allowedActions.join('、');
  return <div className="run-row task-run task-decision">
    <div className="task-run-heading"><strong>{isQuestion ? '问题' : '审批'}</strong>
      <Badge>{isQuestion ? '待回答' : '待审批'}</Badge>
      <Chip color="gray" variant="caption">{isQuestion ? 'Agent 提问'
        : record.request?.kind === 'action' ? '动作审批' : '范围变更'}</Chip></div>
    {record.prompt && <p className="task-review-summary">{record.prompt}</p>}
    {record.request && <dl className="task-run-meta">
      <div><dt>受审 SHA</dt><dd><code>{record.request.sourceSha}</code></dd></div>
      <div><dt>拟议动作</dt><dd>{actionText ?? '—'}</dd></div>
      {record.request.targetBranch && <div><dt>目标分支</dt><dd>{record.request.targetBranch}</dd></div>}
      {record.request.targetSha && <div><dt>目标 SHA</dt><dd><code>{record.request.targetSha}</code></dd></div>}
      {record.request.changeRef && <div><dt>变更请求</dt><dd>{record.request.changeRef}</dd></div>}
      {record.request.reviewRecordId && <div><dt>审查记录</dt><dd>{record.request.reviewRecordId}</dd></div>}
      {record.request.proposedMandate?.maxAutoRisk && <div><dt>风险上限</dt><dd>{record.request.proposedMandate.maxAutoRisk}</dd></div>}
      {record.request.policyVersion && <div><dt>策略版本</dt><dd>{record.request.policyVersion}</dd></div>}
    </dl>}
    {isQuestion && !record.prompt && <QuestionReview taskId={taskId} version={version} targetId={record.id} onDone={onDone} />}
    {isQuestion ? record.prompt && <form onSubmit={submit} className="task-decision-form">
      <label>回答<textarea value={content} onChange={event => { setContent(event.target.value); setDecisionKey(crypto.randomUUID()); }} required /></label>
      <div className="actions"><Button type="submit" disabled={busy}>提交回答</Button></div></form>
      : <div className="actions">
        <Button variant="primary" disabled={busy} onClick={event => void submit(event, 'approve')}>批准</Button>
        <Button disabled={busy} onClick={event => void submit(event, 'reject')}>驳回</Button></div>}
    {error && <p role="alert" className="error">{error.includes('version') ? '任务已更新，请刷新后重新决定' : error}</p>}</div>;
}

function Commands({ detail, actorId, onDone }: { detail: Detail; actorId: string; onDone: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
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
        { method: 'POST', body: { kind, expectedVersion: detail.task.version, idempotencyKey: key } });
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
      setReceipt(`拆分事件已受理：${result.eventId}`); setSplit(''); setSplitKey(crypto.randomUUID()); dialog.current?.close(); onDone();
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
  const canInterrupt = canInterruptTask(detail);
  return <div className="task-command-menu"><Button variant="secondary" size="xs" iconOnly leadingIcon={expanded ? RiCloseLine : RiEditLine}
    aria-label={expanded ? '收起任务操作' : '展开任务操作'} title={expanded ? '收起任务操作' : '展开任务操作'} aria-expanded={expanded}
    onClick={() => { setExpanded(value => !value); setError(''); setReceipt(''); }} />
    {expanded && <div className="task-command-actions">{([
      { kind: 'pause', label: '暂停', icon: RiPauseLine },
      { kind: 'resume', label: '恢复', icon: RiPlayLine },
      { kind: 'retry', label: '重试', icon: RiRestartLine },
      { kind: 'cancel', label: '取消', icon: RiCloseLine },
      { kind: 'takeover', label: '人工接管', icon: RiUserLine },
    ] as const).map(({ kind, label, icon }) =>
      <Button key={kind} variant="secondary" size="xs" leadingIcon={icon}
        title={(kind === 'pause' || kind === 'takeover') && !canInterrupt ? '当前状态或待处理请求不允许中断任务' : undefined}
        disabled={busy || !!detail.task.owner || ((kind === 'pause' || kind === 'takeover') && !canInterrupt)}
        onClick={() => void command(kind)}>{label}</Button>)}
      <Button variant="secondary" size="xs" disabled={busy} onClick={() => dialog.current?.showModal()}>拆分任务</Button></div>}
    {expanded && detail.task.state === 'paused' && detail.task.owner === actorId && <form onSubmit={finishTakeover} className="stack task-takeover-inline">
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
    {expanded && detail.task.owner && detail.task.owner !== actorId && <p className="muted">由 {detail.task.owner} 接管中</p>}
    {expanded && error && <p role="alert" className="error">{error.includes('version') ? '任务已更新，请刷新后重新决定' : error}</p>}
    {expanded && receipt && <p role="status">{receipt}</p>}
    <dialog ref={dialog} className="task-split-dialog" aria-labelledby="task-split-title">
      <h2 id="task-split-title">拆分任务</h2><form onSubmit={doSplit} className="stack">
        <label>任务描述<textarea value={split} onChange={event => { setSplit(event.target.value); setSplitKey(crypto.randomUUID()); }}
          required placeholder="描述独立问题或新增范围" /></label>
        <div className="actions"><Button type="submit" variant="secondary" disabled={busy}>提交拆分事件</Button>
          <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>取消</Button></div>
      </form>{error && <p role="alert" className="error">{error}</p>}
    </dialog>
  </div>;
}

export function TaskDetailPage({ id, actorId, roles }: { id: string; actorId: string; roles: string[] }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [hostResult, setHostResult] = useState('');
  const [hostBusy, setHostBusy] = useState(false);
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
  const openDecisions = detail?.records.filter(item => item.status === 'open' &&
    ['question', 'approval_request'].includes(item.kind)) ?? [];
  const latestReview = detail?.records.filter(item => item.kind === 'review').at(-1);
  const reviewedCi = detail?.records.filter(item => item.kind === 'ci' &&
    item.subjectSha === latestReview?.subjectSha).at(-1);
  const mergedSha = detail?.records.filter(item => item.kind === 'effect' && item.action === 'merge' &&
    item.receipt?.merged && item.receipt.observedSourceSha === latestReview?.subjectSha).at(-1)?.receipt?.mergedSha;
  const pendingReview = detail?.task.state === 'waiting_human' && latestReview?.verdict === 'block'
    ? latestReview : undefined;
  const pendingFindings = Array.from({ length: pendingReview?.findingCount ?? 0 }, (_, index) => index)
    .filter(index => !detail?.records.some(item => item.kind === 'review_resolution' &&
      item.reviewRecordId === pendingReview?.id && item.findingIndex === index));
  const pendingCount = openDecisions.length + pendingFindings.length;
  const prApproval = latestReview && detail?.records.filter(item => item.kind === 'approval_request' &&
    item.request?.action === 'open_pr' && item.request.reviewRecordId === latestReview.id).at(-1);
  const prEffect = latestReview && detail?.records.filter(item => item.kind === 'effect' &&
    item.action === 'open_pr' && item.subjectSha === latestReview.subjectSha).at(-1);
  const showPrApprovalStage = latestReview?.verdict === 'pass' &&
    (detail?.task.mandate.authority.kind === 'auto_pr' || prApproval || prEffect || reviewedCi);
  const showPrDelivery = prApproval?.status === 'approved' || prEffect?.status === 'done';
  const prStageStatus = prEffect?.status === 'done' ? 'PR 已提交'
    : prEffect?.status === 'uncertain' ? '提交结果待核实'
    : prEffect?.status === 'failed' ? '提交失败'
    : prEffect?.status === 'pending' ? '正在提交 PR'
    : prApproval?.status === 'approved' ? '已批准，等待提交'
    : prApproval?.status === 'rejected' ? '已驳回'
    : prApproval?.status === 'invalidated' ? '审批已失效'
    : prApproval?.status === 'open' ? '等待用户审批'
    : detail?.task.state === 'waiting_human' ? '需要人工处理' : '准备审批中';
  const pendingMergeReceipt = detail?.records.some(item => item.kind === 'effect' && item.action === 'merge' &&
    ['pending', 'uncertain'].includes(item.status ?? ''));
  return <div className="stack detail-page"><div className="task-back-actions"><a className="back-link" href="#/tasks">← 返回任务列表</a>
    {detail && roles.includes('command') && <Commands detail={detail} actorId={actorId} onDone={() => setRevision(value => value + 1)} />}</div>
    {error && <p role="alert" className="error">{error}</p>}
    {!detail && !error && <p>正在加载…</p>}
    {detail && <><header className="detail-heading"><span className="eyebrow">任务 / {detail.task.id}</span>
      <h1 title={detail.task.title}>{detail.task.title}</h1><div className="detail-meta"><Badge>{detail.task.state}</Badge>
      <span>{detail.task.repoKey}</span><span>第 {detail.task.iteration} 轮</span><span>版本 {detail.task.version}</span></div></header>
      <Tabs key={id} defaultSelectedKey="overview">
        <div className="task-tabs-scroll"><TabList aria-label="任务详情分组">
          <Tab id="overview">概览</Tab>
          <Tab id="actions" count={pendingCount}>待处理</Tab>
          <Tab id="execution">执行</Tab>
          <Tab id="timeline">时间线</Tab>
        </TabList></div>
        <TabPanel id="overview" shouldForceMount className="stack task-tab-panel">
      <Card className="task-summary"><div className="card-heading"><div><span className="eyebrow">任务边界</span><h2>当前范围与授权</h2></div></div>
        <div className="detail-grid"><div><small>任务范围</small><p>{detail.task.scope}</p></div><div><small>目标</small><p>{detail.task.mandate.goal}</p></div></div>
        <div className="detail-foot">许可动作：{detail.task.mandate.allowedActions.join('、')} <span>策略：{detail.task.mandate.policyVersion}</span></div></Card>
      <Card><h2>来源</h2>{detail.events.length ? detail.events.map(event => <div key={event.id}>
        <p><a href={`#/events/${encodeURIComponent(event.id)}`}>{event.title}</a> <Badge>{event.status}</Badge></p>
        {event.body && <p className="source-text">{event.body}</p>}</div>)
        : <p className="muted">尚无来源记录</p>}</Card>
        </TabPanel>
        <TabPanel id="actions" shouldForceMount className="stack task-tab-panel">
      <Card><h2>待决定事项</h2>{openDecisions.length
        ? openDecisions.map(item =>
          (item.kind === 'question' ? roles.includes('answer') : roles.includes('approve'))
            ? <HumanAction key={item.id} taskId={id} version={detail.task.version} record={item} onDone={() => setRevision(value => value + 1)} />
            : <p key={item.id}>{item.prompt ?? item.request?.kind} · 当前凭据无决定权限</p>)
        : <p className="muted">暂无待决定事项</p>}</Card>
      {pendingReview && pendingFindings.length > 0 && <Card><h2>审查意见待处理</h2>
        {pendingFindings.map(index => {
          const published = detail.records.find(record => record.kind === 'review_finding_publication' &&
            record.reviewRecordId === pendingReview.id && record.findingIndex === index &&
            record.subjectSha === pendingReview.subjectSha);
          return <div className="run-row" key={index}><h3>意见 #{index + 1}</h3>
            {published && <PublishedFinding finding={published} />}
            {published ? roles.includes('approve')
              ? <ReviewResolution taskId={id} version={detail.task.version} review={pendingReview} index={index}
                  onDone={() => setRevision(value => value + 1)} />
              : <p className="muted">等待有审批权限的人处理</p>
              : roles.includes('command')
                ? <ReviewFindingPublication taskId={id} version={detail.task.version} review={pendingReview} index={index}
                    onDone={() => setRevision(value => value + 1)} />
                : <p className="muted">意见内容待人工核对发布</p>}
          </div>;
        })}</Card>}
      {roles.includes('command') && (reviewedCi?.ready && detail.task.state === 'ready_to_merge' || pendingMergeReceipt) &&
        <Card><h2>人工合并</h2><div className="actions task-host-actions">
          {reviewedCi?.ready && detail.task.state === 'ready_to_merge' &&
            <Button disabled={hostBusy} onClick={() => void prepareMerge()}>发起合并审批</Button>}
          {pendingMergeReceipt && <Button disabled={hostBusy} onClick={() => void observeMerge()}>核验人工合并回执</Button>}
        </div></Card>}
        </TabPanel>
        <TabPanel id="execution" shouldForceMount className="stack task-tab-panel">
      <Card><h2>运行与会话</h2>{detail.runs.length ? detail.runs.map((run, index) => {
        const review = run.stage === 'review' ? detail.records.find(item => item.kind === 'review' && item.runId === run.id) : undefined;
        const failureReason = run.status === 'succeeded' ? undefined : run.reason;
        return <div className="run-row task-run" key={run.id}>
        <div className="task-run-heading"><strong>{run.stage}</strong><Badge>{run.status}</Badge>
          <Chip color="gray" variant="caption">{run.agentKind ?? 'Agent 待定'}</Chip></div>
        {(run.sessionId || run.commitSha || failureReason) && <dl className="task-run-meta">
          {run.sessionId && <div><dt>Session</dt><dd><code>{run.sessionId}</code>
            <Button variant="secondary" size="xs" iconOnly leadingIcon={RiFileCopyLine} className="task-quiet-icon-button"
              aria-label={`复制 Session ${run.sessionId}`} title="复制 Session ID"
              onClick={() => void navigator.clipboard.writeText(run.sessionId!)} /></dd></div>}
          {run.commitSha && <div><dt>提交 SHA</dt><dd><code>{run.commitSha}</code></dd></div>}
          {failureReason && <div className="task-run-reason"><dt>原因</dt><dd title={failureReason}><code>{failureReason}</code></dd></div>}
        </dl>}
        {review && <ReviewStageDetails review={review} records={detail.records} nextRun={detail.runs[index + 1]} />}
      </div>; }) : <p className="muted">尚无运行</p>}
        {showPrApprovalStage && <div className="run-row task-run"><div className="task-run-heading task-pr-heading">
          <strong>提交 PR 审批</strong><Chip color={prEffect?.status === 'done' ? 'lime'
            : prApproval?.status === 'rejected' || prEffect?.status === 'failed' ? 'rose' : 'yellow'}
            variant="caption">{prStageStatus}</Chip>
          {showPrDelivery && roles.includes('command') && prEffect?.status === 'done' &&
            <Button variant="secondary" size="xs" iconOnly leadingIcon={RiRefreshLine} className="task-quiet-icon-button"
              aria-label={hostBusy ? '正在刷新平台检查' : '刷新平台检查'} title="刷新平台检查"
              disabled={hostBusy} onClick={() => void refreshCodeHost()} />}</div>
          <details className="task-stage-details">
            <summary>审批与提交详情 <span className="task-approval-status"><Chip color={prApproval?.status === 'approved' ? 'lime'
              : prApproval?.status === 'rejected' ? 'rose' : 'yellow'} variant="caption">
              {prApproval?.status === 'approved' ? '审批通过' : prApproval?.status === 'rejected' ? '审批未通过'
                : prApproval?.status === 'invalidated' ? '审批已失效'
                  : prApproval?.status === 'open' ? '待审批' : '尚未发起'}</Chip></span></summary>
          <p className="muted">审查通过后发起审批；批准后创建 PR，合并由人工操作。</p>
          <dl className="task-run-meta"><div><dt>源 SHA</dt><dd><code>{latestReview?.subjectSha}</code></dd></div>
            {prApproval && <div><dt>审批请求</dt><dd><code>{prApproval.id}</code></dd></div>}
            {prApproval?.request?.targetBranch && <div><dt>目标分支</dt><dd><code>{prApproval.request.targetBranch}</code></dd></div>}
            {prApproval?.request?.targetSha && <div><dt>目标 SHA</dt><dd><code>{prApproval.request.targetSha}</code></dd></div>}
            {prEffect?.receipt?.changeId && <div><dt>PR/MR</dt><dd><code>{prEffect.receipt.changeId}</code></dd></div>}
          </dl>
          {prApproval?.status === 'open' && <p className="muted">请在“待处理”或“通知与审批”中决定。</p>}
          {prApproval?.status === 'rejected' && <p className="muted">审批已驳回，任务等待人工处理，不会自动返回 develop。</p>}
          </details>
          {showPrDelivery && <details className="task-stage-details task-pr-delivery"><summary>CI 与合并</summary>
            {reviewedCi ? <div className="run-row task-review"><div className="task-run-heading">
              <strong>变更请求 {reviewedCi.changeId}</strong><Badge>{reviewedCi.state}</Badge>
              <Chip color={reviewedCi.ready ? 'lime' : 'yellow'} variant="caption">门禁{reviewedCi.ready ? '通过' : '未通过'}</Chip></div>
              <dl className="task-run-meta"><div><dt>源 SHA</dt><dd><code>{reviewedCi.subjectSha}</code></dd></div>
                <div><dt>目标 SHA</dt><dd><code>{reviewedCi.targetSha}</code></dd></div>
                <div><dt>平台状态</dt><dd>{reviewedCi.gate}</dd></div>
                <div><dt>必需检查</dt><dd>{reviewedCi.requiredChecks?.join('、') || '未确认'}</dd></div></dl>
              {reviewedCi.checks?.length ? <div className="task-review-checks">{reviewedCi.checks.map((check, index) =>
                <div key={index}><strong>{check.name}</strong><Badge>{check.status}</Badge><span>{check.conclusion}</span>
                  <code>{check.commitSha}</code></div>)}</div> : null}
            </div> : <p className="muted">尚无平台检查或合并回执</p>}
            {mergedSha && <dl className="task-run-meta"><div className="task-review-wide"><dt>已核实合并提交</dt>
              <dd><code>{mergedSha}</code></dd></div></dl>}
            {hostResult && <p role="status">{hostResult}</p>}
          </details>}
        </div>}</Card>
      <Card><details className="task-evidence-details"><summary><strong>开发证据</strong>
        <span className="task-evidence-expand">展开全部</span><span className="task-evidence-collapse">收起全部</span></summary>
        {detail.records.some(item => item.kind === 'development' || item.kind === 'check')
        ? detail.records.filter(item => item.kind === 'development' || item.kind === 'check').map(item =>
          <div className="run-row task-evidence-item" key={item.id}>{item.kind === 'development' ? <>
            <strong title={`提交 ${item.commitSha}`}>提交 {item.commitSha}</strong><p className="muted">基线 {item.baseSha} · 提交后复核：{item.postCheckVerified ? '通过' : item.postCheckError ?? '未通过'}</p>
            <p>Diff 记录 {item.diff?.recordId} · {item.diff?.sha256 ? `SHA-256 ${item.diff.sha256} · ${item.diff.bytes} 字节`
              : item.diff?.truncated ? '文件超过预览上限' : '文件暂不可读取'}</p></> : <>
            <strong title={`检查 ${item.result} · ${[item.command, ...(item.args ?? [])].filter(Boolean).join(' ')}`}>
              检查 {item.result} · {[item.command, ...(item.args ?? [])].filter(Boolean).join(' ')}</strong>
            <p className="muted">受审 SHA {item.subjectSha} · 退出码 {item.exitCode ?? '未知'} · 终止确认：{item.terminationConfirmed ? '是' : '否'}</p>
            <p>日志记录 {item.log?.recordId} · {item.log?.sha256 ? `SHA-256 ${item.log.sha256} · ${item.log.bytes} 字节`
              : item.log?.truncated ? '文件超过预览上限' : '文件暂不可读取'}</p></>}</div>)
        : <p className="muted">尚无开发证据</p>}</details></Card>
        </TabPanel>
        <TabPanel id="timeline" shouldForceMount className="stack task-tab-panel">
      <Card><h2>事实时间线</h2>{detail.records.length ? <ol className="timeline">{detail.records.map(item =>
        <li key={item.id}><time>{new Date(item.at).toLocaleString()}</time> <Badge>{item.kind}</Badge>
          <p>{item.prompt ?? item.summary ?? item.reason ?? item.content ?? item.result ?? item.status ?? item.decision ?? item.commitSha ?? item.id}</p>
          {item.kind === 'human_result' && item.commitSha && <p className="muted">人工提交 SHA {item.commitSha} · 开发证据记录 {item.developmentRecordId}</p>}
          {item.subjectSha && <p className="muted">SHA {item.subjectSha}</p>}</li>)}</ol>
        : <p className="muted">尚无记录</p>}</Card>
        </TabPanel>
      </Tabs>
    </>}
  </div>;
}
