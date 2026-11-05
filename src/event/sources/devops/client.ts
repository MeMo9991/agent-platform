import type { DefectSourceConfig } from './defects.js';

const baseUrl = 'https://devops.faw.cn/api/collaboration-center/api/scrum/item';

export function createDefectApiReaders(config: DefectSourceConfig,
  authorizationHeaders: () => Promise<HeadersInit>, request: typeof fetch = fetch): {
    readPage(page: number): Promise<unknown>; readDetail(id: number): Promise<unknown>;
  } {
  async function post(path: 'list' | 'query', body: object): Promise<unknown> {
    const headers = new Headers(await authorizationHeaders());
    if (!headers.get('Authorization')) throw new Error('Defect API authorization is unavailable');
    headers.set('Content-Type', 'application/json;charset=UTF-8');
    headers.set('Accept', 'application/json');
    headers.set('qfcsid', 'BA-0208');
    headers.set('qfctid', 'YQJT');
    headers.set('useragent', 'pc');
    headers.set('lang', 'zh-cn');
    const response = await request(`${baseUrl}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Defect API returned HTTP ${response.status}`);
    return response.json();
  }
  return {
    readPage: page => post('list', { itemOperateSource: 'DAYU_PROJECT', statusIdList: [3166016], userRelatedList: ['ASSIGN'],
      group: false, pageSize: config.pageSize ?? 10, pageNum: page, itemType: 'DEFECT', businessProjectId: config.businessProjectId }),
    readDetail: id => post('query', { itemOperateSource: 'DAYU_PROJECT', businessProjectId: String(config.businessProjectId),
      itemId: id, type: 'DEFECT', templateType: 'GENERAL' }),
  };
}
