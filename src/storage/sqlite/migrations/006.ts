import type { DatabaseSync } from 'node:sqlite';
import { defectRevision } from '../../../event/sources/devops/defects.js';
import type { SourceEvent } from '../../../event/model.js';

export function migrateDevopsRevisions(db: DatabaseSync, readEvent: (id: string) => SourceEvent | undefined): void {
  const rows = db.prepare(`SELECT e.id FROM source_event e JOIN event_source s ON s.id=e.source_id
    WHERE s.kind='devops-defect' AND e.kind='bug' AND json_array_length(e.attachments_json)>0
    ORDER BY e.status='done' DESC, e.received_at DESC, e.rowid DESC`).all();
  const groups = new Map<string, { revision: string; events: SourceEvent[] }>();
  for (const row of rows) {
    const event = readEvent(String(row.id));
    if (!event) continue;
    const revision = defectRevision(event);
    const key = JSON.stringify([event.sourceId, event.externalId, revision]);
    const group = groups.get(key);
    if (group) group.events.push(event);
    else groups.set(key, { revision, events: [event] });
  }
  const canonicalize = db.prepare('UPDATE source_event SET revision=? WHERE id=?');
  const archive = db.prepare(`UPDATE source_event SET status='done',lease_until=NULL,routing_data=? WHERE id=?`);
  for (const { revision, events } of groups.values()) {
    const canonical = events.find(event => event.revision === revision) ?? events[0]!;
    canonicalize.run(revision, canonical.id);
    for (const event of events) {
      if (event.id === canonical.id || event.status === 'done') continue;
      archive.run(JSON.stringify({ kind: 'ignored', reason: 'Duplicate DevOps defect snapshot',
        duplicateOf: canonical.id }), event.id);
    }
  }
}
