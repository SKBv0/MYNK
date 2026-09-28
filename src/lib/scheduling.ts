/** Cooperative scheduling helpers for long synchronous work on the main thread. */

type SchedulerLike = { yield?: () => Promise<void> };

/** Lets the browser paint / handle input between chunks. */
export const yieldToMain = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
};
