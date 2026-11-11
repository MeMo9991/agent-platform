import type { SourceEvent } from '../../event/model.js';
import type { Subscription, Task } from '../task/model.js';
import type { TaskMandate } from '../task/model.js';
import type { RouteDecision, TaskCandidateFinder } from '../router/model.js';
import { routeEvent } from '../router/route-event.js';
import { planRoute, type RoutePlan } from './task-loop.js';

export interface EventLoopStore {
  claimEvent(at: string, leaseUntil: string): SourceEvent | undefined;
  subscriptionMatches(event: SourceEvent): Array<{ subscription: Subscription; task: Task }>;
  getTask(id: string): Task | undefined;
  hasBusyRun(taskId: string, iteration: number): boolean;
  commitRoute(eventId: string, plan: RoutePlan, at: string): string | undefined;
}

export function createEventLoop(store: EventLoopStore, trustedRepoBySource: Readonly<Record<string, string | readonly string[]>>,
  policyVersion: string, ruleRef: string, agentKind: string, finder: TaskCandidateFinder, leaseMs = 60_000,
  autoMandate?: (event: SourceEvent) => TaskMandate | undefined) {
  return { processOne(): boolean {
    const now = new Date();
    const event = store.claimEvent(now.toISOString(), new Date(now.getTime() + leaseMs).toISOString());
    if (!event) return false;
    const excludedTaskId = event.routingData && typeof event.routingData === 'object' &&
      'excludedTaskId' in event.routingData && typeof event.routingData.excludedTaskId === 'string'
      ? event.routingData.excludedTaskId : undefined;
    const decision = routeEvent(event, store.subscriptionMatches(event), trustedRepoBySource[event.sourceId],
      policyVersion, ruleRef, finder.find, excludedTaskId, autoMandate);
    const owner = decision.kind === 'existing_task' ? store.getTask(decision.taskId) : undefined;
    const plan = planRoute(event, decision, owner, owner ? store.hasBusyRun(owner.id, owner.iteration) : false,
      agentKind, now.toISOString());
    store.commitRoute(event.id, plan, now.toISOString());
    return true;
  } };
}
