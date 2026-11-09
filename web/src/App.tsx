import { useEffect, useState, type FormEvent } from 'react';
import { RiAddLine, RiDashboardLine, RiFileList2Line, RiSettings3Line, RiShieldKeyholeLine } from '@remixicon/react';
import { api, setToken, token } from './app/api';
import { Button } from './components/ui';
import { ManualSubmit } from './features/manual-submit';
import { EventPage } from './pages/event';
import { OverviewPage } from './pages/overview';
import { TaskDetailPage } from './pages/task-detail';
import { TasksPage } from './pages/tasks';
import { SettingsPage } from './pages/settings';
import { cx } from '@/utils/cx';

type Config = { actorId: string; repoKeys: string[]; autoPrRepoKeys?: string[]; roles: string[]; stage5WritesEnabled?: boolean };
export default function App() {
  const [hash, setHash] = useState(location.hash || '#/');
  const [credential, setCredential] = useState(token());
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState('');
  useEffect(() => { const update = () => setHash(location.hash || '#/');
    addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  useEffect(() => { if (!token()) return;
    void api<Config>('/api/config').then(value => { setConfig(value); setError(''); })
      .catch(cause => { setConfig(undefined); setError(String(cause)); });
  }, [credential]);
  function authenticate(event: FormEvent) { event.preventDefault(); setToken(credential);
    void api<Config>('/api/config').then(value => { setConfig(value); setError(''); })
      .catch(cause => setError(String(cause))); }
  if (!config) return <main className="login-page"><div className="login-card">
    <div className="brand-mark"><RiShieldKeyholeLine aria-hidden /></div>
    <span className="eyebrow">本机任务控制台</span>
    <h1>进入工作台</h1><p className="muted">使用本机 API 凭据查看任务和待处理事项。</p>
    <form onSubmit={authenticate} className="stack"><label>API 凭据<input type="password" value={credential}
      onChange={event => setCredential(event.target.value)} autoComplete="off" required placeholder="粘贴凭据" /></label>
      <Button type="submit" variant="primary">进入看板</Button></form>{error && <p role="alert" className="error">{error}</p>}
  </div></main>;
  const segments = hash.replace(/^#\//, '').split('/');
  const section = segments[0] === 'tasks' ? 'tasks' : segments[0] === 'new' ? 'new' : segments[0] === 'settings' ? 'settings' : 'overview';
  const page = segments[0] === 'tasks' && segments[1] ? <TaskDetailPage id={decodeURIComponent(segments[1])} actorId={config.actorId} roles={config.roles} stage5WritesEnabled={config.stage5WritesEnabled === true} />
    : segments[0] === 'tasks' ? <TasksPage repoKeys={config.repoKeys} canDelete={config.roles.includes('command')} />
    : segments[0] === 'events' && segments[1] ? <EventPage id={decodeURIComponent(segments[1])} repoKeys={config.repoKeys} canRoute={config.roles.includes('route')} />
    : segments[0] === 'new' ? config.roles.includes('submit') ? <ManualSubmit repoKeys={config.repoKeys} autoPrRepoKeys={config.autoPrRepoKeys ?? []} /> : <p>当前凭据没有提交任务权限。</p>
    : segments[0] === 'settings' ? config.roles.includes('configure') ? <SettingsPage /> : <p>当前凭据没有配置权限。</p> : <OverviewPage />;
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
