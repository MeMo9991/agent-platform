import { SqliteStore } from '../storage/sqlite/store.js';
import { createEventIngress } from '../event/ingress.js';

const allowedMetaDataFields = { sample: ['label'] };
const store = new SqliteStore(':memory:', allowedMetaDataFields);
try {
  store.registerSource('sample', 'sample', 'sample-config', true);
  const ingress = createEventIngress(store, allowedMetaDataFields);
  const sample = { sourceId: 'sample', externalId: 'bug-1', revision: '1', kind: 'bug', title: '页面报错',
    body: '中文描述与截图', attachments: [{ id: 'image-1', kind: 'image' as const, sourceRef: 'sample/image-1' }], metaData: { label: 'ui' } };
  const first = await ingress.accept(sample);
  const second = await ingress.accept(sample);
  if (first.duplicate || !second.duplicate || first.eventId !== second.eventId || !store.get(first.eventId)) throw new Error('Event ingress selfcheck failed');
  console.log('Stage 1 selfcheck passed: validated, saved, read and deduplicated one event');
} finally { store.close(); }
