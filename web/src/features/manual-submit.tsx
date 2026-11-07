import { useState, type FormEvent } from 'react';
import { api } from '../app/api';
import { Button, Card } from '../components/ui';
import { Select, SelectItem } from '@/components/base/select/select';
import { Textarea } from '@/components/base/textarea/textarea';
import { RiArrowRightLine, RiFileAddLine, RiImageAddLine } from '@remixicon/react';

type Receipt = { eventId: string; taskId?: string; status: string; duplicate: boolean };
export function ManualSubmit({ repoKeys }: { repoKeys: string[] }) {
  const [repoKey, setRepoKey] = useState(repoKeys[0] ?? '');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitKey, setSubmitKey] = useState(() => crypto.randomUUID());
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
        body: { repoKey, body, images, idempotencyKey: submitKey } });
      setReceipt(result); setBody(''); setFiles([]); setSubmitKey(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败'); }
    finally { setBusy(false); }
  }
  return <div className="stack submit-page"><header className="page-heading"><div><span className="eyebrow">工作台 / 新任务</span>
    <h1>提交新任务</h1><p className="muted">描述工作目标，平台受理后通过 Router 关联任务。</p></div></header>
    <Card className="submit-card"><div className="submit-icon"><RiFileAddLine aria-hidden /></div>
      <h2>任务内容</h2><p className="muted">提交后返回回执，进展和结果可在任务详情查看</p>
      <form onSubmit={submit} className="stack">
        <Select label="目标仓库" selectedKey={repoKey} onSelectionChange={key => { setRepoKey(String(key ?? '')); setSubmitKey(crypto.randomUUID()); }} isRequired>
          {repoKeys.map(key => <SelectItem key={key} id={key}>{key}</SelectItem>)}</Select>
        <Textarea label="任务描述" value={body} onChange={value => { setBody(value); setSubmitKey(crypto.randomUUID()); }} rows={5}
          maxLength={20000} isRequired placeholder="描述目标、现象、复现步骤或需要调查的问题…" />
        <label className="upload-box"><span className="upload-icon"><RiImageAddLine aria-hidden /></span><span><strong>添加图片</strong><small>最多 2 张，每张不超过 10 MB；支持 PNG、JPEG、GIF、WebP</small></span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple
            onChange={event => { setFiles(Array.from(event.target.files ?? [])); setSubmitKey(crypto.randomUUID()); }} /></label>
        {files.length > 0 && <p className="muted">已选择：{files.map(file => file.name).join('、')}</p>}
        <Button type="submit" variant="primary" trailingIcon={RiArrowRightLine} disabled={busy || !repoKey}>{busy ? '提交中…' : '提交任务'}</Button>
      </form>{error && <p role="alert" className="error">{error}</p>}
    </Card>
    {receipt && <Card className="receipt-card" ><p role="status"><strong>{receipt.duplicate ? '此前已受理' : '任务已受理'}</strong> · {receipt.status}</p>
      <div className="actions"><a href={`#/events/${encodeURIComponent(receipt.eventId)}`}>查看事件 →</a>
        {receipt.taskId && <a href={`#/tasks/${encodeURIComponent(receipt.taskId)}`}>查看任务 →</a>}</div></Card>}
  </div>;
}
