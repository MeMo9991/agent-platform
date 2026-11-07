import { createReadStream, lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { AttachmentReader, AttachmentRef } from '../../model.js';

export function createManualAttachmentReader(sourceId: string, directory: string): AttachmentReader {
  return { async open(requestedSourceId: string, ref: AttachmentRef) {
    if (requestedSourceId !== sourceId || ref.kind !== 'image' ||
        ref.sourceRef !== `manual/${ref.id}` || !/^[a-f0-9-]{36}$/.test(ref.id))
      throw new Error('Invalid manual image reference');
    const root = realpathSync(directory);
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid?.() ||
        (directoryInfo.mode & 0o077) !== 0)
      throw new Error('Manual image directory is not private');
    const path = resolve(root, ref.id);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !statSync(path).isFile() ||
        statSync(path).size > 10 * 1024 * 1024)
      throw new Error('Manual image is unavailable or invalid');
    return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  } };
}
