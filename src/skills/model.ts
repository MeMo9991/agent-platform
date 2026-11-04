import { z } from 'zod';
import { id } from '../shared/model.js';

export const skillRef = z.object({ repoRef: id, path: id, commitSha: id, stage: z.enum(['investigate', 'develop', 'verify', 'review', 'release_prepare']) })
  .refine(value => !value.path.startsWith('/') && !value.path.split('/').includes('..'), 'Skill path must stay in its repository');
export const loadedSkill = z.object({ content: id, ref: skillRef });
export interface SkillLoader { load(ref: z.infer<typeof skillRef>): Promise<z.infer<typeof loadedSkill>> }
