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
    if (name === 'system-prompt' && (!text.includes('{{mandate}}') || !text.includes('{{skill}}')) ||
        name === 'review' && !text.includes('{{baseSha}}'))
      throw new Error(`Qoder ${name} prompt is missing a required placeholder`);
    const values = { mandate: JSON.stringify(request.mandate), skill: request.skill.content,
      baseSha: request.workspace.baseSha };
    return text.replace(/\{\{(mandate|skill|baseSha)\}\}/g, (_, key: keyof typeof values) => values[key]);
  };
  return [read('system-prompt'),
    ...(request.stage === 'develop' ? [read('develop')] : []),
    ...(['investigate', 'develop'].includes(request.stage) ? [read('question')] : []),
    ...(request.stage === 'review' ? [read('review')] : [])].join('\n');
}
