import { z } from 'zod';
import { id } from '../../shared/model.js';
import { mandate } from '../task/model.js';

export const associationEvidence = z.object({ kind: id, sourceRef: id, details: id });
export const routeCandidate = z.object({ taskId: id, evidence: z.array(associationEvidence), confidence: z.number().min(0).max(1).optional() });
export const routeDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing_task'), taskId: id, contextTaskIds: z.array(id), evidence: z.array(associationEvidence).min(1) }),
  z.object({ kind: z.literal('new_task'), repoKey: id, mandate, parentTaskId: id.optional() }),
  z.object({ kind: z.literal('needs_human'), candidates: z.array(routeCandidate), reason: id }),
  z.object({ kind: z.literal('ignored'), reason: id }),
]);
export type RouteDecision = z.infer<typeof routeDecision>;
export interface EventRouter { route(eventId: string): Promise<RouteDecision> }
export interface TaskCandidateFinder { find(eventId: string): Promise<z.infer<typeof routeCandidate>[]> }
