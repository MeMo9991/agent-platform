import type { EventIngress, PollingSource } from './model.js';

export async function pollSource(source: PollingSource, ingress: EventIngress): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  const seen = new Set<string>();
  // shortcut: offset pages can shift during concurrent edits; use a snapshot cursor if this API later exposes one.
  do {
    const page = await source.read(cursor);
    for (const event of page.events) { await ingress.accept(event); count++; }
    cursor = page.nextCursor;
    if (cursor && (!seen.add(cursor) || seen.size > 1000)) throw new Error('Defect pagination did not terminate');
  } while (cursor);
  return count;
}
