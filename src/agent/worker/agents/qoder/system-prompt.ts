import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { z } from 'zod';
import type { runRequest } from '../../model.js';

const promptDirectory = fileURLToPath(new URL('../../../../../src/agent/worker/agents/qoder/', import.meta.url));

export function buildQoderSystemPrompt(request: z.infer<typeof runRequest>, directory = promptDirectory): string {
  const read = (name: string) => {
    const text = readFileSync(join(directory, `${name}.md`), 'utf8').trim();
    if (!text || Buffer.byteLength(text, 'utf8') > 32_768) throw new Error(`Qoder ${name} prompt is empty or too large`);
    if (name === 'system-prompt' && !text.includes('{{mandate}}') ||
        name === 'review' && !text.includes('{{baseSha}}'))
      throw new Error(`Qoder ${name} prompt is missing a required placeholder`);
    // 临时关闭自定义 Skill：不再注入 stage 级 SKILL.md 内容。
    const values = { mandate: JSON.stringify(request.mandate), baseSha: request.workspace.baseSha };
    return text.replace(/\{\{(mandate|baseSha)\}\}/g, (_, key: keyof typeof values) => values[key]);
  };
  return [read('system-prompt'),
    ...(request.stage === 'investigate' ? [read('investigate')] : []),
    ...(request.stage === 'develop' ? [read('develop')] : []),
    ...(request.stage === 'review' ? [read('review')] : [])].join('\n');
}
