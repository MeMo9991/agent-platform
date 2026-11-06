import type { SqliteStore } from '../src/storage/sqlite/store.js';
import { createTaskCandidateFinder } from '../src/agent/router/candidate-finder.js';
import { createEventLoop as createEventLoopCore } from '../src/agent/kernel/event-loop.js';
import { createKernelCoordinator as createKernelCoordinatorCore } from '../src/agent/kernel/coordinator.js';

export function createEventLoop(store: SqliteStore, trustedRepos: Readonly<Record<string, string>>,
  policyVersion: string, ruleRef: string, agentKind: string, leaseMs?: number) {
  return createEventLoopCore(store, trustedRepos, policyVersion, ruleRef, agentKind,
    createTaskCandidateFinder(store), leaseMs);
}

export function createKernelCoordinator(store: SqliteStore, trustedRepos: Readonly<Record<string, string>>,
  policyVersion: string, ruleRef: string, agentKind: string, allowedRepos: readonly string[]) {
  return createKernelCoordinatorCore(store, trustedRepos, policyVersion, ruleRef, agentKind,
    allowedRepos, createTaskCandidateFinder(store));
}
