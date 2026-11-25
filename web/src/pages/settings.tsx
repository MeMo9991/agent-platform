import { useEffect, useState } from 'react';
import { RiRefreshLine } from '@remixicon/react';
import { api } from '../app/api';
import { Button } from '@/components/base/buttons/button';
import { Textarea } from '@/components/base/textarea/textarea';
import { Card } from '../components/ui';

type Group = 'instance' | 'projectGroups' | 'schedules' | 'agents' | 'budget' | 'policyRef' |
  'releasePipelines' | 'review' | 'devopsCredentials';
type Settings = {
  revision: string; configurationSource: 'local' | 'legacy'; configurationFile?: string; pendingRestart: boolean; configurationError?: string;
  groups: Record<Exclude<Group, 'devopsCredentials'>, unknown> & { projectGroups: ProjectGroupCredential[] };
  protected: { qoderPatConfigured: boolean; devopsCredentialsConfigured: boolean;
    devopsCredentialSource: 'local' | 'external'; devopsCredentialError?: string };
};
type ProjectGroupCredential = { projectKey: string; tokenConfigured: boolean };
type CredentialGroup = 'qoderPat' | 'projectGroupToken' | 'devopsCredentials';
const categories: { id: string; title: string; groups: { id: Group; title: string; hint?: string }[] }[] = [
  { id: 'instance', title: '实例', groups: [{ id: 'instance', title: '端口与当前能力' }] },
  { id: 'projects', title: '项目组', groups: [{ id: 'projectGroups', title: '项目组与仓库' }] },
  { id: 'scans', title: '定时扫描', groups: [{ id: 'schedules', title: '事件扫描任务' }] },
  { id: 'agents', title: 'Agent 与预算', groups: [
    { id: 'agents', title: 'Agent' }, { id: 'budget', title: '运行预算' }] },
  { id: 'credentials', title: '外部认证', groups: [{ id: 'devopsCredentials', title: 'DevOps 凭据' }] },
  { id: 'review', title: '校验策略', groups: [
    { id: 'policyRef', title: '策略引用' }, { id: 'review', title: '审查策略' }] },
  { id: 'release', title: '发布映射', groups: [
    { id: 'releasePipelines', title: '发布流水线', hint: '映射已保留，发布执行尚未接入。' }] },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState<string>();
  const [projectTokens, setProjectTokens] = useState<Record<string, string>>({});
  const [qoderPat, setQoderPat] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [cookie, setCookie] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [feedbackGroup, setFeedbackGroup] = useState<Group>();
  const load = () => api<Settings>('/api/settings').then(value => { setSettings(value); setError(''); });
  const reload = () => void load().catch(cause => { setFeedbackGroup(undefined); setError(String(cause)); });
  useEffect(reload, []);

  async function save(group: CredentialGroup, value: unknown, clear: () => void, message: string, id: string = group) {
    if (!settings || busy) return;
    setBusy(id); setError(''); setNotice('');
    setFeedbackGroup(group === 'qoderPat' ? 'agents' : group === 'projectGroupToken' ? 'projectGroups' : group);
    try {
      await api(`/api/settings/${group}`, { method: 'PUT', body: { expectedRevision: settings.revision, value } });
      clear();
      setNotice(message);
      await load();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(undefined); }
  }

  const devopsConfigured = settings?.protected.devopsCredentialsConfigured;
  return <div className="stack settings-page"><header className="page-heading">
    <div><h1>配置</h1><p className="muted">
      {settings?.configurationSource === 'legacy'
        ? '在启动时指定的配置文件修改运行配置，重启后生效。'
        : `在 ${settings?.configurationFile ?? 'config/local.yaml'} 修改运行配置，重启后生效。`}
    </p></div>
    <Button size="small" variant="ghost" iconOnly leadingIcon={RiRefreshLine}
      aria-label="刷新配置" title="刷新配置" onClick={reload} />
  </header>
    <div className="settings-content">
      {error && !feedbackGroup && <p role="alert" className="error">{error}</p>}
      {settings?.configurationError && <p role="alert" className="error">配置文件校验失败，服务继续使用启动时的配置。{settings.configurationError}</p>}
      {settings?.pendingRestart && <p role="status">文件已修改，重启后生效。下方显示当前生效的配置。</p>}
      {!settings && !error && <p role="status">正在加载配置…</p>}
      {settings && categories.map(category => <section key={category.id} className="settings-section"
        aria-labelledby={`settings-${category.id}`}>
        <h2 id={`settings-${category.id}`} className="settings-category-title">{category.title}</h2>
        {category.groups.map(group => {
          const json = group.id === 'devopsCredentials' ? undefined : JSON.stringify(settings.groups[group.id], null, 2);
          return <Card key={group.id} className="settings-card">
            <div className="settings-card-header"><div><h3>{group.title}</h3>{group.hint && <p>{group.hint}</p>}</div></div>
            {json !== undefined && <Textarea isReadOnly aria-label={`${group.title} JSON`} value={json}
              rows={Math.min(18, Math.max(3, json.split('\n').length))} resize="vertical" className="font-mono"
              fieldClassName="bg-background-primary-default border border-separator-border" />}
            {group.id === 'devopsCredentials' && (settings.protected.devopsCredentialSource === 'external'
              ? <p>当前由外部鉴权模块提供凭据。</p>
              : <>
                {settings.protected.devopsCredentialError && <p role="alert">本机凭据无法读取，请重新录入两项。</p>}
                <p className="muted">{devopsConfigured ? '已配置。留空保留原值。' : '首次设置请填写两项。'}保存后在下次请求使用。</p>
                <div className="settings-token-row">
                  <label>Authorization
                    <input type="password" autoComplete="new-password" value={authorization}
                      onChange={event => setAuthorization(event.target.value)} />
                  </label>
                  <label>Cookie
                    <input type="password" autoComplete="new-password" value={cookie}
                      onChange={event => setCookie(event.target.value)} />
                  </label>
                  <Button size="small" variant="primary" disabled={Boolean(busy) ||
                    (devopsConfigured ? !authorization.trim() && !cookie.trim() : !authorization.trim() || !cookie.trim())}
                    onClick={() => void save('devopsCredentials', {
                      authorization: authorization.trim() || undefined, cookie: cookie.trim() || undefined,
                    }, () => { setAuthorization(''); setCookie(''); }, 'DevOps 凭据已更新，下次请求生效。')}>
                    {busy === 'devopsCredentials' ? '保存中…' : '保存凭据'}</Button>
                </div>
              </>)}
            {group.id === 'agents' && <div className="settings-token-row">
              <label>QoderCN PAT
                <input type="password" autoComplete="new-password" value={qoderPat} maxLength={4096}
                  placeholder={settings.protected.qoderPatConfigured ? '已配置，输入新值可替换' : '输入 QoderCN 专用 PAT'}
                  onChange={event => setQoderPat(event.target.value)} />
              </label>
              <Button size="small" variant="primary" disabled={Boolean(busy) || !qoderPat.trim()}
                onClick={() => void save('qoderPat', { token: qoderPat }, () => setQoderPat(''),
                  'QoderCN PAT 已更新，下次写模式 Run 生效。')}>
                {busy === 'qoderPat' ? '保存中…' : '保存 PAT'}</Button>
            </div>}
            {group.id === 'projectGroups' && settings.groups.projectGroups.map(project => {
              const key = project.projectKey;
              const id = `projectGroupToken:${key}`;
              const token = projectTokens[key] ?? '';
              return <div className="settings-token-row" key={key}>
                <label>{key} · 仓库 Token
                  <input type="password" autoComplete="new-password" value={token}
                    placeholder={project.tokenConfigured ? '已配置，输入新值可替换' : '输入项目组 Token'}
                    onChange={event => setProjectTokens(current => ({ ...current, [key]: event.target.value }))} />
                </label>
                <Button size="small" variant="primary" disabled={Boolean(busy) || !token.trim()}
                  onClick={() => void save('projectGroupToken', { projectKey: key, token: token.trim() },
                    () => setProjectTokens(current => ({ ...current, [key]: '' })),
                    '仓库 Token 已更新。下次请求使用新值，外部写入范围在重启预检后更新。', id)}>
                  {busy === id ? '保存中…' : '保存 Token'}</Button>
              </div>;
            })}
            {feedbackGroup === group.id && error && <p role="alert" className="error">{error}</p>}
            {feedbackGroup === group.id && notice && <p role="status" className="settings-notice">{notice}</p>}
          </Card>;
        })}
      </section>)}
    </div>
  </div>;
}
