export function startWorkerLoop(worker: { tick(): Promise<unknown>; poll(): Promise<unknown> },
  intervalMs: number, onError: (error: unknown) => void) {
  let stopping = false;
  let active: Promise<void> | undefined;
  const runOnce = () => {
    if (stopping || active) return;
    active = (async () => { await worker.tick(); await worker.poll(); })()
      .catch(onError).finally(() => { active = undefined; });
  };
  const timer = setInterval(runOnce, intervalMs);
  return { runOnce, async stop() {
    if (stopping) { if (active) await active; return; }
    stopping = true;
    clearInterval(timer);
    if (active) await active;
  } };
}
