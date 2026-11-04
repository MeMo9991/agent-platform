import { unavailable } from '../shared/model.js';
import type { AgentRunner } from '../agent/worker/model.js';
import type { CodeHost, ReleasePipeline } from '../repository-ci/model.js';
import type { SkillLoader } from '../skills/model.js';

export const unavailableAgent: AgentRunner = {
  capabilities: () => ({}),
  start: async () => unavailable('agent.start'), resume: async () => unavailable('agent.resume'),
  send: async () => unavailable('agent.send'), read: async () => unavailable('agent.read'),
  cancel: async () => unavailable('agent.cancel'),
};
export const unavailableCodeHost: CodeHost = {
  repoKey: '', provider: 'github',
  readChecks: async () => unavailable('code-host.read-checks'),
  openChange: async () => unavailable('code-host.open-change'),
  readChange: async () => unavailable('code-host.read-change'),
  merge: async () => unavailable('code-host.merge'),
};
export const unavailableReleasePipeline: ReleasePipeline = {
  repoKey: '', environment: '',
  start: async () => unavailable('release.start'),
  findByRequestKey: async () => unavailable('release.find-by-request-key'),
  read: async () => unavailable('release.read'),
};
export const unavailableSkillLoader: SkillLoader = { load: async () => unavailable('skill.load') };
