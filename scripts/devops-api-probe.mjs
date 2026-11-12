#!/usr/bin/env node
import { createDefectApiReaders } from '../dist/event/sources/devops/client.js';
import { createDefectSource } from '../dist/event/sources/devops/defects.js';

const config = {
  sourceId: 'devops-assigned',
  businessProjectId: 4655971863,
  pageSize: 5
};

// Get token from env or command line
const token = process.env.DEVOPS_TOKEN || process.argv[2];
if (!token) {
  console.error('Usage: DEVOPS_TOKEN=<token> node scripts/devops-api-probe.mjs');
  console.error('   or: node scripts/devops-api-probe.mjs <token>');
  process.exit(1);
}

async function authorizationHeaders() {
  return { 
    Authorization: token,
    Cookie: 'JSESSIONID=E41687E5831795BE1EEA58BE756A6615'
  };
}

console.log('Testing DevOps API with businessProjectId:', config.businessProjectId);
console.log('---');

try {
  const readers = createDefectApiReaders(config, authorizationHeaders);
  
  console.log('1. Reading page 1...');
  const page = await readers.readPage(1);
  
  if (!page.success) {
    console.error('API returned success=false:', page);
    process.exit(1);
  }
  
  console.log('   Success! Code:', page.code);
  console.log('   Total defects:', page.data?.total);
  console.log('   Page:', page.data?.pageNum, 'Size:', page.data?.pageSize);
  
  const items = page.data?.list || [];
  console.log('   Items on page:', items.length);
  
  if (items.length > 0) {
    console.log('\n2. First defect:');
    const first = items[0];
    console.log('   ID:', first.id);
    console.log('   Subject:', first.subject?.slice(0, 80));
    console.log('   Status:', first.statusId);
    console.log('   Priority:', first.priority);
    console.log('   Created:', first.gmtCreated);
    console.log('   Modified:', first.gmtModified);
    
    console.log('\n3. Reading defect detail...');
    const detail = await readers.readDetail(first.id);
    if (detail.success && detail.data?.description) {
      console.log('   Detail loaded, description length:', detail.data.description.length);
    } else {
      console.error('   Detail failed:', detail);
    }
    
    console.log('\n4. Testing full source read (normalize to events)...');
    const source = createDefectSource(config, readers.readPage, readers.readDetail);
    const result = await source.read(undefined);
    console.log('   Events generated:', result.events.length);
    if (result.events.length > 0) {
      const event = result.events[0];
      console.log('   First event:');
      console.log('     sourceId:', event.sourceId);
      console.log('     externalId:', event.externalId);
      console.log('     kind:', event.kind);
      console.log('     title:', event.title?.slice(0, 60));
      console.log('     revision:', event.revision?.slice(0, 16) + '...');
      console.log('     body length:', event.body?.length);
    }
    console.log('   Next cursor:', result.nextCursor || '(none - last page)');
  }
  
  console.log('\n✓ DevOps API test passed!');
} catch (error) {
  console.error('\n✗ Error:', error.message);
  if (error.message.includes('Unexpected token')) {
    console.error('  (This usually means auth failed and got HTML login page)');
  }
  process.exit(1);
}
