import type { DatabaseSync } from 'node:sqlite';
import type { SourceEvent } from '../../../event/model.js';
import { defectAssociation, defectAttachmentKey } from '../../../event/sources/devops/defects.js';

export function migrateEventAssociations(db: DatabaseSync, readEvent: (id: string) => SourceEvent | undefined): void {
  const events = db.prepare(`SELECT e.id FROM source_event e JOIN event_source s ON s.id=e.source_id
    WHERE s.kind='devops-defect' AND e.kind='bug'`);
  const update = db.prepare('UPDATE source_event SET meta_data=?,attachments_json=? WHERE id=?');
  for (const row of events.all()) {
    const event = readEvent(String(row.id));
    if (!event) continue;
    const { businessProjectId, statusId } = event.metaData;
    if (typeof businessProjectId !== 'number' || typeof statusId !== 'number') continue;
    const metaData = { ...event.metaData, association: defectAssociation(businessProjectId, statusId) };
    const attachments = event.attachments.map(ref => ({ ...ref, stableKey: defectAttachmentKey(ref.sourceRef) }));
    update.run(JSON.stringify(metaData), JSON.stringify(attachments), event.id);
  }
}
