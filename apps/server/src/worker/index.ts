import { sql } from "drizzle-orm";
import { config } from "../config";
import { workerHeartbeats } from "../db/schema";
import { getDb } from "../db/client";
import { logger } from "../logger";
import { claimNextJob, recoverStaleJobs, runJob } from "../engine/jobs";
import { runDueSync, runSchedule } from "../engine/schedule";
import { noteProgress, secondsWithoutProgress, startWatchdog } from "./liveness";

/**
 * The worker: runs queued jobs and, once a minute, the schedule and one due
 * read from a connection.
 *
 * One worker is enough for most organizations; more can run side by side,
 * because each job is claimed with a row lock, one worker at a time runs the
 * schedule and one at a time reads from connections. On SIGTERM it finishes
 * the job it is running first. A watchdog ends a worker that is stuck
 * (liveness.ts), so that its container restarts it.
 */

export type Stop = () => Promise<void>;

export const SCHEDULE_SECONDS = 60;
/** The heartbeat is written at most this often. */
export const HEARTBEAT_SECONDS = 10;
/**
 * During long work the heartbeat goes on while the worker made progress
 * within this time; a stuck worker stops beating.
 */
export const PROGRESS_SECONDS = 60;

export class Worker {
  stopping = false;
  private lastBeat: number | null = null;
  private wake: (() => void) | null = null;

  /** One round: recover stale jobs, the schedule when due, the queued jobs, one due read. */
  async round(options: { scheduleDue: boolean }): Promise<number> {
    await this.beat();
    // A failing schedule must not hold up the jobs, and the other way round.
    try {
      await recoverStaleJobs();
      if (options.scheduleDue) {
        const summary = await runSchedule();
        if (Object.values(summary).some(Boolean)) logger.info({ summary }, "schedule");
      }
    } catch (error) {
      logger.error({ err: error }, "worker schedule failed");
    }
    let ran = 0;
    try {
      ran = await this.runJobs();
    } catch (error) {
      logger.error({ err: error }, "worker round failed");
    }
    // Reads come after the jobs, one per minute at most: a slow connection holds
    // up the jobs for one read, and the jobs queued meanwhile run next.
    if (options.scheduleDue && !this.stopping) {
      try {
        await runDueSync();
      } catch (error) {
        logger.error({ err: error }, "worker read failed");
      }
    }
    return ran;
  }

  async runJobs(limit = 50): Promise<number> {
    let ran = 0;
    while (ran < limit && !this.stopping) {
      const job = await claimNextJob();
      if (job === null) break;
      await runJob(job);
      ran += 1;
      await this.beat();
    }
    return ran;
  }

  /** Tells the watchdog, the dashboard and /-/readyz that the worker is getting somewhere. */
  async beat(): Promise<void> {
    noteProgress();
    await this.writeHeartbeat();
  }

  /**
   * Keeps the heartbeat fresh during one long read, where every answer from a
   * connected app counts as progress.
   */
  async beatIfProgressing(): Promise<boolean> {
    if (secondsWithoutProgress() >= PROGRESS_SECONDS) return false;
    await this.writeHeartbeat();
    return true;
  }

  private async writeHeartbeat(): Promise<void> {
    const now = performance.now();
    if (this.lastBeat !== null && now - this.lastBeat < HEARTBEAT_SECONDS * 1000) return;
    try {
      await getDb()
        .insert(workerHeartbeats)
        .values({ name: "worker", beatAt: new Date() })
        .onConflictDoUpdate({ target: workerHeartbeats.name, set: { beatAt: sql`excluded.beat_at` } });
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.name : "Error" }, "worker heartbeat failed");
      return;
    }
    this.lastBeat = now;
  }

  async sleep(seconds: number): Promise<void> {
    const deadline = performance.now() + seconds * 1000;
    while (!this.stopping && performance.now() < deadline) {
      noteProgress();
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, Math.min(200, Math.max(deadline - performance.now(), 0)));
      });
      this.wake = null;
    }
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }
}

/** Starts the worker loop; the returned function stops it after the job it is running. */
export async function startWorker(options: { once?: boolean } = {}): Promise<Stop> {
  const settings = config();
  const worker = new Worker();
  const stops: (() => void)[] = [];
  if (!options.once) {
    stops.push(startWatchdog(settings.WORKER_STALL_SECONDS, settings.WORKER_ALIVE_FILE));
    const heartbeat = setInterval(() => void worker.beatIfProgressing(), HEARTBEAT_SECONDS * 1000);
    heartbeat.unref();
    stops.push(() => clearInterval(heartbeat));
  }
  logger.info("worker started");
  const loop = (async () => {
    let lastSchedule = Number.NEGATIVE_INFINITY;
    while (!worker.stopping) {
      const due = options.once === true || performance.now() - lastSchedule >= SCHEDULE_SECONDS * 1000;
      if (due) lastSchedule = performance.now();
      const ran = await worker.round({ scheduleDue: due });
      if (options.once) break;
      if (!ran) await worker.sleep(settings.WORKER_POLL_SECONDS);
    }
    logger.info("worker stopped");
  })();
  return async () => {
    worker.stop();
    await loop;
    for (const stop of stops) stop();
  };
}
