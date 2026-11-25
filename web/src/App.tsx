import { useEffect, useState } from 'react';
import { RiAddLine, RiDashboardLine, RiFileList2Line, RiSettings3Line, RiShieldKeyholeLine } from '@remixicon/react';
import { api } from './app/api';
import { ManualSubmit } from './features/manual-submit';
import { EventPage } from './pages/event';
import { OverviewPage } from './pages/overview';
import { TaskDetailPage } from './pages/task-detail';
import { TasksPage } from './pages/tasks';
import { SettingsPage } from './pages/settings';
import { cx } from '@/utils/cx';

type Config = { actorId: string; repoKeys: string[]; unverifiedRepoKeys?: string[]; stage5WritesEnabled?: boolean; manualCloneRoot?: string; projectGroups: {
  projectKey: string; repoKeys: string[]; defaultRepoKey?: string }[]; roles: string[] };
export default function App() {
  const [hash, setHash] = useState(location.hash || '#/');
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState('');
  useEffect(() => { const update = () => setHash(location.hash || '#/');
    addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  useEffect(() => {
    void api<Config>('/api/config').then(value => { setConfig(value); setError(''); })
      .catch(cause => { setConfig(undefined); setError(String(cause)); });
  }, []);
  if (!config) return <main className="login-page"><div className="login-card" role="status">
    {error ? <p role="alert" className="error">看板加载失败：{error}</p> : <p>正在加载看板…</p>}
  </div></main>;
  const segments = hash.replace(/^#\//, '').split('/');
  const section = segments[0] === 'tasks' ? 'tasks' : segments[0] === 'new' ? 'new' : segments[0] === 'settings' ? 'settings' : 'overview';
  const page = segments[0] === 'tasks' && segments[1] ? <TaskDetailPage key={segments[1]} id={decodeURIComponent(segments[1])}
    actorId={config.actorId} roles={config.roles} stage5WritesEnabled={config.stage5WritesEnabled === true}
    manualCloneRoot={config.manualCloneRoot} initialTab={segments[2] === 'actions' ? 'actions' : 'overview'} />
    : segments[0] === 'tasks' ? <TasksPage repoKeys={config.repoKeys} canDelete={config.roles.includes('command')} />
    : segments[0] === 'events' && segments[1] ? <EventPage id={decodeURIComponent(segments[1])} repoKeys={config.repoKeys}
      unverifiedRepoKeys={config.unverifiedRepoKeys ?? []} canRoute={config.roles.includes('route')}
      canApprove={config.roles.includes('approve')} />
    : segments[0] === 'new' ? config.roles.includes('submit') ? <ManualSubmit projectGroups={config.projectGroups} /> : <p>当前操作者没有提交任务权限。</p>
    : segments[0] === 'settings' ? config.roles.includes('configure') ? <SettingsPage /> : <p>当前操作者没有配置权限。</p> : <OverviewPage />;
  const navigation = [
    { id: 'overview', href: '#/', label: '待办总览', icon: RiDashboardLine },
    { id: 'tasks', href: '#/tasks', label: '任务列表', icon: RiFileList2Line },
    ...(config.roles.includes('submit') ? [{ id: 'new', href: '#/new', label: '提交任务', icon: RiAddLine }] : []),
    ...(config.roles.includes('configure') ? [{ id: 'settings', href: '#/settings', label: '配置', icon: RiSettings3Line }] : []),
  ];
  return <div className="workspace"><aside className="sidebar">
    <a className="brand" href="#/"><span className="brand-mark"><RiShieldKeyholeLine aria-hidden /></span><span>Agent Platform<small>本机任务控制台</small></span></a>
    <div className="nav-label">工作区</div><nav aria-label="主导航">{navigation.map(item => <a key={item.id} href={item.href}
      aria-current={section === item.id ? 'page' : undefined}
      className={cx('nav-link', section === item.id && 'active')}><item.icon aria-hidden />{item.label}</a>)}</nav>
    <div className="sidebar-footer"><span className="avatar">{config.actorId.slice(0, 1).toUpperCase()}</span><span><strong>{config.actorId}</strong><small>当前操作者</small></span></div>
  </aside><div className="workspace-main"><div className="topbar"><span>工作台 <span className="topbar-divider">/</span> {navigation.find(item => item.id === section)?.label ?? '任务详情'}</span>
    {config.roles.includes('submit') && <a className="topbar-action" href="#/new"><RiAddLine aria-hidden /> 新建任务</a>}</div>
    <main className="content">{page}</main></div></div>;
}
