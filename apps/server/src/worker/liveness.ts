import fs from "node:fs";
import { logger } from "../logger";

/**
 * Whether the worker is getting anywhere.
 *
 * The worker loop counts as progress each round and after each job, and so
 * does every answer from a connected app (src/adapters/http.ts), so a long
 * read of a big directory is progress too. A worker without any for
 * WORKER_STALL_SECONDS is stuck, for example on a database connection whose
 * server went away: the watchdog then ends the process, and the container's
 * restart policy starts a fresh one. A job it was running goes back to the
 * queue once its lease runs out.
 *
 * While the worker makes progress, the watchdog touches WORKER_ALIVE_FILE
 * for the container's health check (compose.yaml).
 */

export const WATCH_SECONDS = 10;

let lastProgress = performance.now();

export function noteProgress(): void {
  lastProgress = performance.now();
}

export function secondsWithoutProgress(): number {
  return (performance.now() - lastProgress) / 1000;
}

/**
 * One look of the watchdog. Ends the process when the worker is stuck;
 * returns whether it is alive.
 */
export function watch(
  stallSeconds: number,
  options: { aliveFile: string; stop?: (code: number) => void },
): boolean {
  const stalled = secondsWithoutProgress();
  if (stalled > stallSeconds) {
    try {
      logger.fatal(
        { seconds: Math.round(stalled) },
        "the worker made no progress and stops, so that it is restarted",
      );
    } finally {
      // The worker stops even when its report fails.
      (options.stop ?? ((code: number) => process.exit(code)))(1);
    }
    return false;
  }
  try {
    const now = new Date();
    try {
      fs.utimesSync(options.aliveFile, now, now);
    } catch {
      fs.writeFileSync(options.aliveFile, "");
    }
  } catch {
    logger.warn({ file: options.aliveFile }, "could not touch the alive file for the health check");
  }
  return true;
}

/** Starts the watchdog; returns a function that stops it. */
export function startWatchdog(stallSeconds: number, aliveFile: string): () => void {
  noteProgress();
  const timer = setInterval(() => watch(stallSeconds, { aliveFile }), WATCH_SECONDS * 1000);
  timer.unref();
  watch(stallSeconds, { aliveFile });
  return () => clearInterval(timer);
}
