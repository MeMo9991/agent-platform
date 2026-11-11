import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../app/api';
import { Button } from '@/components/base/buttons/button';
import { Select, SelectItem } from '@/components/base/select/select';
import { Textarea } from '@/components/base/textarea/textarea';
import { cx } from '@/utils/cx';
import type { Event } from '../shared/types';
import { RiArrowRightLine, RiArrowUpLine, RiAttachmentLine, RiGitRepositoryLine } from '@remixicon/react';

// 回形针图标旋转 45°，与参考图的斜置附件图标一致
function AttachmentIcon({ className, ...rest }: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) {
  return <RiAttachmentLine {...rest} className={cx(className, 'rotate-45')} />;
}

type Receipt = { eventId: string; taskId?: string; status: string; duplicate: boolean };
export function ManualSubmit({ projectGroups }: { projectGroups: {
  projectKey: string; repoKeys: string[]; defaultRepoKey?: string }[] }) {
  const [projectKey, setProjectKey] = useState(projectGroups[0]?.projectKey ?? '');
  const [repoKey, setRepoKey] = useState('');
  const group = projectGroups.find(item => item.projectKey === projectKey);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitKey, setSubmitKey] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const eventId = receipt?.eventId;
  const taskId = receipt?.taskId;
  const status = receipt?.status;
  useEffect(() => {
    if (!eventId || taskId || status === 'ignored') return;
    let active = true;
    const refresh = () => { void api<Event>(`/api/events/${encodeURIComponent(eventId)}`)
      .then(event => { if (active) setReceipt(current => current?.eventId === event.id
        ? { ...current, status: event.status, taskId: event.taskId } : current); })
      .catch(() => { /* The receipt stays available while a transient refresh fails. */ }); };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [eventId, taskId, status]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (files.length > 2 || files.some(file => file.size > 10 * 1024 * 1024))
        throw new Error('最多上传 2 张图片，每张不超过 10 MB');
      const images = await Promise.all(files.map(async file => ({ mimeType: file.type,
        data: await new Promise<string>((resolve, reject) => { const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject;
          reader.readAsDataURL(file); }) })));
      const result = await api<Receipt>('/api/events', { method: 'POST',
        body: { projectKey, ...(repoKey ? { repoKey } : {}), body, images, idempotencyKey: submitKey } });
      setReceipt(result); setBody(''); setFiles([]); setSubmitKey(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败'); }
    finally { setBusy(false); }
  }
  return <div className="chat-submit-page">
    <div className="chat-submit-content">
      {!receipt ? <div className="chat-submit-intro"><span className="text-caption-1-medium text-text-tertiary">新任务</span>
        <h1 className="text-title-1-medium text-text-primary">有什么任务需要处理？</h1>
        <p className="text-body-regular text-text-secondary">描述目标或问题，提交后会返回受理结果。任务进展与结论可在任务详情查看。</p></div>
        : <div className="chat-submit-result" role="status"><span className="text-caption-1-medium text-text-tertiary">提交结果</span>
          <h1 className="text-title-2-medium text-text-primary">{receipt.duplicate ? '此前已受理' : '任务已受理'}</h1>
          <p className="text-body-regular text-text-secondary">{receipt.taskId ? '已关联任务，可前往任务详情查看结果。'
            : receipt.status === 'needs_human' ? '等待人工确认关联任务。'
              : receipt.status === 'ignored' ? '此事件无需建立任务。' : '正在关联任务，请稍候。'}</p>
          {receipt.taskId ? <a className="chat-submit-task-link" href={`#/tasks/${encodeURIComponent(receipt.taskId)}`}>
            查看对应任务 <RiArrowRightLine aria-hidden /></a>
            : <a className="chat-submit-event-link" href={`#/events/${encodeURIComponent(receipt.eventId)}`}>查看受理事件</a>}</div>}
    </div>
    <form onSubmit={submit} className="chat-submit-composer">
      <Textarea aria-label="任务描述" value={body} onChange={value => { setBody(value); setSubmitKey(crypto.randomUUID()); }}
        rows={3} autoResize maxRows={5} maxLength={20000} fieldClassName="bg-background-primary-default" isRequired
        placeholder="描述目标、现象、复现步骤或需要调查的问题…" />
      <div className="chat-submit-toolbar"><div className="chat-submit-options">
        <Select aria-label="项目组" className="chat-submit-repo" size="sm"
          triggerClassName="rounded-full border-border-button-default bg-background-secondary-default px-3 py-1.5 shadow-none hover:bg-background-secondary-hover"
          selectedKey={projectKey} onSelectionChange={key => { setProjectKey(String(key ?? '')); setRepoKey(''); setSubmitKey(crypto.randomUUID()); }} isRequired>
          {projectGroups.map(item => <SelectItem key={item.projectKey} id={item.projectKey}>{item.projectKey}</SelectItem>)}</Select>
        <Select aria-label="代码仓库" className="chat-submit-repo" size="sm"
          triggerClassName="rounded-full border-border-button-default bg-background-secondary-default px-3 py-1.5 shadow-none hover:bg-background-secondary-hover"
          renderValue={<span className="flex min-w-0 items-center gap-2"><RiGitRepositoryLine aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
            <span className="truncate">{repoKey || '自动选择'}</span></span>}
          selectedKey={repoKey || 'auto'} onSelectionChange={key => { setRepoKey(key === 'auto' ? '' : String(key ?? '')); setSubmitKey(crypto.randomUUID()); }}>
          <SelectItem id="auto">自动选择</SelectItem>
          {group?.repoKeys.map(key => <SelectItem key={key} id={key}>{key}</SelectItem>)}</Select>
        <Button type="button" variant="secondary" size="medium" iconOnly leadingIcon={AttachmentIcon}
          className="rounded-full bg-background-secondary-default shadow-none hover:bg-background-secondary-hover"
          aria-label="添加图片附件" title="添加图片附件（最多 2 张，每张不超过 10 MB）"
          onClick={() => fileInput.current?.click()} />
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
          onChange={event => { setFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; setSubmitKey(crypto.randomUUID()); }} />
      </div><Button type="submit" variant="primary" size="medium" iconOnly leadingIcon={RiArrowUpLine}
        className="rounded-full bg-text-primary text-background-primary-default shadow-none hover:bg-text-secondary disabled:bg-background-tertiary-default disabled:text-text-tertiary"
        aria-label={busy ? '提交中' : '提交任务'} title={busy ? '提交中' : '提交任务'} disabled={busy || !projectKey || !group?.repoKeys.length} /></div>
      {files.length > 0 && <p className="chat-submit-files text-caption-1-medium text-text-tertiary">{files.map(file => file.name).join('、')}</p>}
      {error && <p role="alert" className="error chat-submit-error">{error}</p>}
    </form>
    <p className="chat-submit-note text-caption-1-medium text-text-tertiary">图片最多 2 张，每张不超过 10 MB · 提交后不会在此展示执行过程</p>
  </div>;
}
