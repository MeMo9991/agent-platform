import { useEffect, useState } from 'react';
import { RiDeleteBinLine, RiFileList2Line } from '@remixicon/react';
import { api } from '../app/api';
import { Badge, Button, Card } from '../components/ui';
import { Input } from '@/components/base/input/input';
import { Select, SelectItem } from '@/components/base/select/select';
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from '@/components/base/table/table';
import { ScrollFade, useScrollFade } from '@/components/foundations/scroll-fade/scroll-fade';
import type { Task } from '../shared/types';

export function TasksPage({ repoKeys, canDelete }: { repoKeys: string[]; canDelete: boolean }) {
  const [state, setState] = useState('');
  const [repoKey, setRepoKey] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: Task[]; total: number }>();
  const [error, setError] = useState('');
  const filterFade = useScrollFade();
  const tableFade = useScrollFade();
  const [deleting, setDeleting] = useState<string>();
  async function deleteTask(taskId: string) {
    if (!confirm('确定要删除这个任务吗？此操作不可恢复。')) return;
    setDeleting(taskId);
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      setData(current => current ? { items: current.items.filter(item => item.id !== taskId),
        total: current.total - 1 } : current);
    } catch (cause) { alert(`删除失败：${cause}`); }
    finally { setDeleting(undefined); }
  }
  useEffect(() => { let live = true;
    const query = new URLSearchParams({ limit: '25', offset: String(offset), state, repoKey, sourceId,
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}) });
    const load = () => api<{ items: Task[]; total: number }>(`/api/tasks?${query}`)
      .then(result => { if (live) { setData(result); setError(''); } })
      .catch(cause => { if (live) setError(String(cause)); });
    void load(); const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [state, repoKey, sourceId, from, to, offset]);
  return <div className="stack"><header className="page-heading"><div><span className="eyebrow">工作台 / 任务记录</span>
    <h1>任务列表</h1><p className="muted">按状态、仓库和来源找到任务，打开详情查看事实与证据。</p></div>
    <div className="task-list-meta"><span className="count-pill">{data?.total ?? '—'} 条任务</span>
      <span>约每 5 秒刷新</span></div></header>
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p>正在加载任务…</p>}
    <Card className="task-table-card"><div className={`filter-card${filtersOpen ? ' filters-open' : ''}`}>
      <Button className="filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>{filtersOpen ? '收起筛选' : '展开筛选'}</Button>
      <div className="filter-scroll-wrap"><div className="filters" onScroll={filterFade.onScroll}>
      <Select aria-label="状态" selectedKey={state || 'all'} onSelectionChange={key => { setState(key === 'all' ? '' : String(key ?? '')); setOffset(0); }}>
        <SelectItem id="all">全部状态</SelectItem>{['queued','investigating','developing','verifying','waiting_human','paused','blocked','failed','cancelled','closed'].map(value =>
          <SelectItem key={value} id={value}>{value}</SelectItem>)}</Select>
      <Select aria-label="仓库" selectedKey={repoKey || 'all'} onSelectionChange={key => { setRepoKey(key === 'all' ? '' : String(key ?? '')); setOffset(0); }}>
        <SelectItem id="all">全部仓库</SelectItem>{repoKeys.map(value => <SelectItem key={value} id={value}>{value}</SelectItem>)}</Select>
      <Input aria-label="来源 ID" value={sourceId} onChange={value => { setSourceId(value); setOffset(0); }} placeholder="来源 ID" />
      <Input type="date" aria-label="开始日期" leadingAddon={<span className="text-caption-1-medium text-text-tertiary">从</span>}
        value={from} onChange={value => { setFrom(value); setOffset(0); }} />
      <Input type="date" aria-label="结束日期" leadingAddon={<span className="text-caption-1-medium text-text-tertiary">到</span>}
        value={to} onChange={value => { setTo(value); setOffset(0); }} />
    </div><ScrollFade progress={filterFade.progress} /></div></div>
      {data?.items.length ? <div className="task-table-scroll-wrap"><div className="task-table-scroll" onScroll={tableFade.onScroll}>
        <Table aria-label="任务列表" size="sm"><TableHeader>
        <TableColumn isRowHeader>任务</TableColumn><TableColumn>状态</TableColumn><TableColumn>仓库</TableColumn><TableColumn>更新时间</TableColumn><TableColumn>行动</TableColumn>
      </TableHeader><TableBody>{data.items.map(task => <TableRow key={task.id} id={task.id}>
        <TableCell><a className="task-link" href={`#/tasks/${encodeURIComponent(task.id)}`}>{task.title}</a><small className="row-subtitle">{task.id}</small></TableCell>
        <TableCell><Badge>{task.state}</Badge></TableCell><TableCell>{task.repoKey}</TableCell>
        <TableCell>{new Date(task.updatedAt).toLocaleString()}</TableCell>
        <TableCell><Button variant="ghost" size="xs" iconOnly leadingIcon={RiDeleteBinLine}
          className="text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary"
          disabled={!canDelete || deleting === task.id} onClick={() => deleteTask(task.id)}
          aria-label={`删除任务 ${task.title}`} title="删除任务" /></TableCell>
      </TableRow>)}</TableBody></Table></div>
        <ScrollFade progress={tableFade.progress} /></div>
        : <div className="empty-state"><RiFileList2Line aria-hidden /><strong>没有符合条件的任务</strong><span>调整筛选条件后重试</span></div>}
      <div className="pager"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>上一页</Button>
        <span>{data ? `${data.total ? offset + 1 : 0}–${Math.min(offset + 25, data.total)} / ${data.total}` : '—'}</span>
        <Button disabled={!data || offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>下一页</Button></div></Card>
  </div>;
}
