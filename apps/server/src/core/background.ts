import { logger } from "../logger";

/**
 * Work that goes on after its request has its answer, such as the email
 * about a new identity request. A stop (a deploy restarts the app at any
 * time) waits for it with `settleBackground`, so that a restart does not cut
 * it short. Failures are logged, never thrown.
 */
const pending = new Set<Promise<void>>();

export function runInBackground(work: () => unknown, message = "background work failed"): void {
  const running = Promise.resolve()
    .then(work)
    .then(
      () => undefined,
      (error: unknown) => logger.error({ err: error }, message),
    )
    .finally(() => pending.delete(running));
  pending.add(running);
}

/**
 * Waits until the background work has finished, also work that starts
 * meanwhile, for at most `timeoutMs`. Resolves with the number of tasks
 * still running then.
 */
export async function settleBackground(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(timer);
  }
  return pending.size;
}
