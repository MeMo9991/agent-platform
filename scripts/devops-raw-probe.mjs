import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const tokenPath = process.argv[2] || resolve(homedir(), '.config/devops-token.txt');
let token;
try {
  token = readFileSync(tokenPath, 'utf8').trim();
} catch (e) {
  console.error('Could not read token from:', tokenPath);
  console.error('Please save your token to ~/.config/devops-token.txt');
  process.exit(1);
}
if (!token) { console.error('Token file is empty'); process.exit(1); }

const baseUrl = 'https://devops.faw.cn/api/collaboration-center/api/scrum/item/list';
const body = {
  itemOperateSource: 'DAYU_PROJECT',
  statusIdList: [3166016],
  userRelatedList: ['ASSIGN'],
  group: false,
  pageSize: 5,
  pageNum: 1,
  itemType: 'DEFECT',
  businessProjectId: 4655971863
};

const headers = {
  'Authorization': token,
  'Content-Type': 'application/json;charset=UTF-8',
  'Accept': 'application/json',
  'qfcsid': 'BA-0208',
  'qfctid': 'YQJT',
  'useragent': 'pc',
  'lang': 'zh-cn'
};

const resp = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(body) });
const text = await resp.text();

if (resp.status === 401 || resp.status === 403) {
  console.log('Auth failed: HTTP', resp.status);
} else if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
  console.log('Auth failed: got HTML login page');
} else {
  try {
    const json = JSON.parse(text);
    console.log('Success!');
    console.log('  code:', json.code);
    console.log('  success:', json.success);
    console.log('  total:', json.data?.total);
    console.log('  items:', json.data?.list?.length ?? 0);
  } catch {
    console.log('Parse error, response start:', text.slice(0, 100));
  }
}
