import { createDefectApiReaders } from './src/event/sources/devops/client.ts';

const config = {
  sourceId: 'devops-assigned',
  businessProjectId: 4655971863,
  pageSize: 10
};

async function authorizationHeaders() {
  const tokenPath = process.env.HOME + '/.config/agent-platform/local-api.token';
  try {
    const { readFileSync } = await import('node:fs');
    const token = readFileSync(tokenPath, 'utf8').trim();
    return { Authorization: `Bearer ${token}` };
  } catch {
    console.error('No token file found at', tokenPath);
    return {};
  }
}

try {
  const readers = createDefectApiReaders(config, authorizationHeaders);
  console.log('Reading page 1...');
  const page = await readers.readPage(1);
  console.log('Page result keys:', Object.keys(page));
  console.log('Success:', page.success, 'Total:', page.data?.total ?? page.total);
  const items = page.data?.list ?? page.data?.records ?? page.list ?? page.records ?? [];
  console.log('Items count:', Array.isArray(items) ? items.length : 'N/A');
  if (Array.isArray(items) && items.length > 0) {
    console.log('First item:', JSON.stringify(items[0], null, 2).slice(0, 500));
  }
} catch (error) {
  console.error('Error:', error.message);
}
