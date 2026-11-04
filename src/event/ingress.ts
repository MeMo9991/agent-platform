import { normalizedEvent, validateMetadataFields, type EventIngress, type EventRepository, type MetadataFields } from './model.js';

export function createEventIngress(repository: EventRepository, allowedMetaDataFields: MetadataFields): EventIngress {
  return { async accept(input) { const event = normalizedEvent.parse(input); validateMetadataFields(event, allowedMetaDataFields); return repository.accept(event); } };
}
