import type { AttachmentReader, AttachmentRef } from '../../model.js';

const maxImageBytes = 10 * 1024 * 1024;
const referencePattern = /^devops-file\/([a-f0-9]{32})\/([a-f0-9]{32})$/;
const attachmentOrigin = 'https://devops-obs.faw.cn';

export function createDevopsAttachmentReader(sourceId: string, authorizationHeaders: () => Promise<HeadersInit>,
  request: typeof fetch = fetch): AttachmentReader {
  return { async open(requestedSourceId: string, ref: AttachmentRef) {
    const match = referencePattern.exec(ref.sourceRef);
    if (requestedSourceId !== sourceId || ref.kind !== 'image' || !match || ref.id !== match[2] ||
        (ref.expiresAt && Date.parse(ref.expiresAt) <= Date.now())) throw new Error('Invalid or expired defect image reference');
    const headers = new Headers(await authorizationHeaders());
    if (!headers.get('Authorization')) throw new Error('Defect image authorization is unavailable');
    const sourceUrl = `https://devops.faw.cn/api/document/fileRelation/getRelatedFile/${match[1]}/${match[2]}`;
    let response: Response;
    try {
      response = await request(sourceUrl, { method: 'GET', headers, redirect: 'manual' });
      if (response.status === 302) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        const target = location ? URL.parse(location, sourceUrl) : null;
        if (target?.origin !== attachmentOrigin || target.username || target.password)
          throw new Error('Untrusted DevOps attachment redirect');
        response = await request(target, { method: 'GET', redirect: 'error', credentials: 'omit' });
      }
    } catch (error) {
      if (error instanceof TypeError) throw new Error('DevOps attachment download failed', { cause: error });
      throw error;
    }
    if (!response.ok || !response.body || !response.headers.get('Content-Type')?.toLowerCase().startsWith('image/') ||
        Number(response.headers.get('Content-Length') ?? 0) > maxImageBytes) {
      await response.body?.cancel();
      throw new Error('Defect image is unavailable or invalid');
    }
    let total = 0;
    return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxImageBytes) throw new Error('Defect image exceeds size limit');
        controller.enqueue(chunk);
      },
    }));
  } };
}
