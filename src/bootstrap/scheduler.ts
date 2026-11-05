import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { id } from '../shared/model.js';

export const scheduledTask = z.object({
  id, kind: id, enabled: z.boolean(), intervalSeconds: z.number().int().min(1).max(2_147_483),
  runOnStart: z.boolean(), parameters: z.record(z.string(), z.unknown()),
}).strict();
export const scheduleConfig = z.object({ tasks: z.array(scheduledTask) }).strict().refine(
  value => new Set(value.tasks.map(task => task.id)).size === value.tasks.length, 'Duplicate scheduled task ID');
export type ScheduleConfig = z.infer<typeof scheduleConfig>;
export type TaskHandler = (parameters: Record<string, unknown>) => Promise<void>;

export function loadScheduleConfig(path: string): ScheduleConfig {
  return scheduleConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function startSchedules(config: ScheduleConfig, handlers: Readonly<Record<string, TaskHandler | undefined>>,
  onError: (taskId: string, error: unknown) => void): () => Promise<void> {
  const tasks = scheduleConfig.parse(config).tasks.filter(task => task.enabled);
  for (const task of tasks) if (!handlers[task.kind]) throw new Error(`No handler for scheduled task ${task.id}: ${task.kind}`);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  for (const task of tasks) {
    const tick = () => {
      if (stopped || active.has(task.id)) return;
      const run = Promise.resolve().then(() => handlers[task.kind]!(task.parameters))
        .catch(error => {
          try { onError(task.id, error); }
          catch (reportError) { console.error(`Scheduled task ${task.id} error reporter failed`, reportError); }
        }).finally(() => { active.delete(task.id); });
      active.set(task.id, run);
    };
    if (task.runOnStart) tick();
    timers.push(setInterval(tick, task.intervalSeconds * 1000));
  }
  return async () => { stopped = true; for (const timer of timers) clearInterval(timer); await Promise.all(active.values()); };
}
