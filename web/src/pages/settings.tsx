import { useEffect, useState } from 'react';
import { api } from '../app/api';
import { Button } from '@/components/base/buttons/button';
import { Textarea } from '@/components/base/textarea/textarea';
import { Card } from '../components/ui';
import { cx } from '@/utils/cx';

type Group = 'repositories' | 'sources' | 'schedules' | 'agents' | 'budget' | 'policyRef' | 'releasePipelines' | 'port';
type Settings = { revision: string; restartRequired: boolean; groups: Record<Group, unknown>;
  protected: { actorId?: string; roles?: string[]; credentialFileConfigured: boolean } };
const categories: { id: string; title: string; groups: { id: Group; title: string; hint: string }[] }[] = [
  { id: 'repositories', title: '仓库与检查', groups: [
    { id: 'repositories', title: '代码仓库', hint: '仓库、目标分支、必需检查和本地检查命令。绝对本机路径不回显；不填写会保留原值，填写 null 可清除。凭据引用只读，新仓库先使用未配置状态。' }] },
  { id: 'sources', title: '来源与调度', groups: [
    { id: 'sources', title: '事件来源', hint: '来源 ID、类型、关联配置及启用状态。' },
    { id: 'schedules', title: '轮询任务', hint: '轮询间隔、启动执行及 DevOps 参数。parameters 键：sourceId（必填）、businessProjectId（必填）、pageSize（可选）、repoKey（可选）。' }] },
  { id: 'agents', title: 'Agent 与预算', groups: [
    { id: 'agents', title: 'Agent', hint: '当前阶段仅支持 Qoder。' },
    { id: 'budget', title: '运行预算', hint: '运行时长、并发上限及人工恢复保留名额。' },
    { id: 'policyRef', title: '策略引用', hint: '任务采用的策略版本引用。' }] },
  { id: 'release', title: '发布映射', groups: [
    { id: 'releasePipelines', title: '发布流水线', hint: '仓库、环境与流水线配置引用。' }] },
  { id: 'service', title: '服务与权限', groups: [
    { id: 'port', title: 'API 端口', hint: '本机 API 监听端口，重启后生效。' }] },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>();
  const [category, setCategory] = useState(categories[0]!.id);
  const [drafts, setDrafts] = useState<Partial<Record<Group, string>>>({});
  const [busy, setBusy] = useState<Group>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api<Settings>('/api/settings').then(value => {
    setSettings(value);
    setDrafts(Object.fromEntries(Object.entries(value.groups).map(([key, item]) => [key, JSON.stringify(item, null, 2)])));
    setError('');
  });
  useEffect(() => { void load().catch(cause => setError(String(cause))); }, []);
  async function save(group: Group) {
    if (!settings) return;
    setBusy(group); setError(''); setNotice('');
    try {
      const value = JSON.parse(drafts[group] ?? 'null') as unknown;
      await api(`/api/settings/${group}`, { method: 'PUT', body: { expectedRevision: settings.revision, value } });
      await load(); setNotice('配置已保存。重启服务后生效。');
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(undefined); }
  }
  const active = categories.find(item => item.id === category)!;
  return <div className="stack settings-page"><header className="page-heading"><div><span className="eyebrow">工作台 / 本机配置</span>
    <h1>配置</h1><p className="muted">维护仓库、来源、Agent、预算与服务参数</p></div></header>
    <div className="settings-layout"><nav className="settings-nav" aria-label="配置分类">{categories.map(item =>
      <button key={item.id} type="button" className={cx('settings-nav-item', category === item.id && 'active')}
        aria-current={category === item.id ? 'page' : undefined} onClick={() => { setCategory(item.id); setError(''); setNotice(''); }}>{item.title}</button>)}</nav>
      <div className="settings-content"><div className="settings-banner">每组单独保存 · 重启服务后生效</div>
        {error && <p role="alert" className="error">{error} <Button size="xs" variant="secondary" onClick={() => void load().catch(cause => setError(String(cause)))}>重新载入</Button></p>}
        {notice && <p role="status" className="settings-notice">{notice}</p>}
        {!settings && !error && <p>正在加载配置…</p>}
        {settings && <><h2 className="settings-category-title">{active.title}</h2>{active.groups.map(group => <Card key={group.id} className="settings-card">
          <div className="settings-card-header"><div><h3>{group.title}</h3><p>{group.hint}</p></div>
            <Button size="small" variant="primary" disabled={busy !== undefined || drafts[group.id] === JSON.stringify(settings.groups[group.id], null, 2)}
              onClick={() => void save(group.id)}>{busy === group.id ? '保存中…' : '保存此组'}</Button></div>
          <Textarea aria-label={`${group.title} JSON`} value={drafts[group.id] ?? ''} onChange={value => setDrafts(current => ({ ...current, [group.id]: value }))}
            rows={Math.min(18, Math.max(4, (drafts[group.id]?.split('\n').length ?? 4) + 1))} resize="vertical" className="font-mono"
            fieldClassName="bg-background-primary-default border border-separator-border" />
        </Card>)}{category === 'service' && <Card className="settings-card"><h3>受保护的信任根</h3>
          <p className="muted">身份：{settings.protected.actorId ?? '未配置'} · 角色：{settings.protected.roles?.join('、') || '无'} · 凭据文件：{settings.protected.credentialFileConfigured ? '已配置' : '未配置'}</p>
          <p className="muted">这些字段只能在受信配置文件中维护，API 不返回凭据内容或文件路径。</p></Card>}</>}
      </div></div></div>;
}
