import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadedSkill, skillRef, type SkillLoader } from './model.js';

const exec = promisify(execFile);
export function createGitSkillLoader(repoPaths: Readonly<Record<string, string>>): SkillLoader {
  return { async load(input) {
    const ref = skillRef.parse(input);
    const cwd = repoPaths[ref.repoRef];
    if (!cwd || ref.path !== `skills/${ref.stage}/SKILL.md` ||
        !['investigate', 'develop'].includes(ref.stage) || !/^[a-f0-9]{40}$/.test(ref.commitSha))
      throw new Error('SkillRef is not allowed for this stage or repository');
    const { stdout } = await exec('git', ['show', `${ref.commitSha}:${ref.path}`], { cwd, maxBuffer: 1024 * 1024 });
    if (!stdout.trim()) throw new Error(`Skill ${ref.path} is empty at ${ref.commitSha}`);
    return loadedSkill.parse({ ref, content: stdout });
  } };
}
