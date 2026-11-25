import type { SourceEvent } from '../../event/model.js';
import type { Subscription, Task } from '../task/model.js';
import type { TaskMandate } from '../task/model.js';
import type { RouteDecision, TaskCandidateFinder } from '../router/model.js';
import { routeEvent } from '../router/route-event.js';
import { continuationReopenStates } from '../task/transition.js';
import { planRoute, type RoutePlan } from './task-loop.js';

export interface EventLoopStore {
  claimEvent(at: string, leaseUntil: string): SourceEvent | undefined;
  subscriptionMatches(event: SourceEvent): Array<{ subscription: Subscription; task: Task }>;
  getTask(id: string): Task | undefined;
  hasActiveRun(taskId: string): boolean;
  hasOpenHumanRequest(taskId: string): boolean;
  hasBusyRun(taskId: string, iteration: number): boolean;
  commitRoute(eventId: string, plan: RoutePlan, at: string): string | undefined;
}

export function createEventLoop(store: EventLoopStore, trustedRepoBySource: Readonly<Record<string, string | readonly string[]>>,
  policyVersion: string, ruleRef: string, agentKind: string, finder: TaskCandidateFinder, leaseMs = 60_000,
  autoMandate?: (event: SourceEvent) => TaskMandate | undefined,
  investigationApprovalSources: ReadonlySet<string> = new Set()) {
  return { processOne(): boolean {
    const now = new Date();
    const event = store.claimEvent(now.toISOString(), new Date(now.getTime() + leaseMs).toISOString());
    if (!event) return false;
    const excludedTaskId = event.routingData && typeof event.routingData === 'object' &&
      'excludedTaskId' in event.routingData && typeof event.routingData.excludedTaskId === 'string'
      ? event.routingData.excludedTaskId : undefined;
    const matches = store.subscriptionMatches(event);
    if (typeof event.metaData.associationCycle === 'string') {
      const candidates = matches.filter(match => match.subscription.mode === 'handle');
      const owner = candidates.length === 1 ? candidates[0]?.task : undefined;
      const repos = trustedRepoBySource[event.sourceId];
      if (!owner || owner.id === excludedTaskId || owner.state === 'cancelled' ||
          (typeof repos === 'string' ? repos !== owner.repoKey : !repos?.includes(owner.repoKey)) ||
          (event.repoKey && event.repoKey !== owner.repoKey) || owner.mandate.policyVersion !== policyVersion ||
          !owner.mandate.allowedActions.includes('investigate') ||
          (continuationReopenStates.has(owner.state) && (store.hasActiveRun(owner.id) || store.hasOpenHumanRequest(owner.id)))) {
        store.commitRoute(event.id, { decision: { kind: 'needs_human',
          candidates: candidates.map(match => ({ taskId: match.task.id, evidence: [] })),
          reason: '来源反馈需要确认原任务的归属或当前状态' } }, now.toISOString());
      } else {
        const plan = planRoute(event, { kind: 'existing_task', taskId: owner.id, contextTaskIds: [],
          evidence: [{ kind: 'subscription', sourceRef: event.externalId, details: '来源反馈关联到原任务' }] },
          owner, store.hasBusyRun(owner.id, owner.iteration), agentKind, now.toISOString());
        store.commitRoute(event.id, { ...plan, continuation: { policyVersion, agentKind } }, now.toISOString());
      }
      return true;
    }
    const decision = routeEvent(event, matches, trustedRepoBySource[event.sourceId],
      policyVersion, ruleRef, finder.find, excludedTaskId, autoMandate);
    const owner = decision.kind === 'existing_task' ? store.getTask(decision.taskId) : undefined;
    const plan = planRoute(event, decision, owner, owner ? store.hasBusyRun(owner.id, owner.iteration) : false,
      agentKind, now.toISOString(), investigationApprovalSources.has(event.sourceId));
    store.commitRoute(event.id, plan, now.toISOString());
    return true;
  } };
}
