import { serve } from "@hono/node-server";
import { config } from "./config";
import { logger } from "./logger";
import { closeDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { createApp } from "./http/app";
import { flushErrorReports } from "./error-reporting";
import { settleBackground } from "./core/background";
import { startWorker, type Stop } from "./worker";

/**
 * One entry point for every process. APP_ROLE selects what runs:
 *   all      web app and worker (default, simplest deployment)
 *   web      web app and API
 *   worker   jobs, the schedule and the reads from connections
 *   migrate  apply database migrations (taking over a Django database), then exit
 */
/**
 * How long a stop waits for background work: below compose.yaml's
 * stop_grace_period of web (40 seconds), above an email's timeouts.
 */
const BACKGROUND_SECONDS = 30;

async function main() {
  const settings = config();
  const role = settings.APP_ROLE;
  if (role === "migrate") {
    await runMigrations();
    await closeDb();
    return;
  }
  if (settings.RUN_MIGRATIONS) await runMigrations();
  if (settings.DEV_LOGIN)
    logger.warn("DEV_LOGIN is on: anyone can sign in as any app user. Development only.");
  if (settings.READ_ONLY)
    logger.warn("read-only mode: connected apps are read, never changed, and no email is sent");
  let server: ReturnType<typeof serve> | undefined;
  const stops: Stop[] = [];
  if (role === "all" || role === "web") {
    const app = createApp();
    server = serve({ fetch: app.fetch, port: settings.PORT, hostname: settings.HOST }, (info) => {
      logger.info({ port: info.port, url: settings.APP_URL }, "web app listening");
    });
  }
  if (role === "all" || role === "worker") stops.push(await startWorker());

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    await Promise.allSettled([
      server ? new Promise<void>((resolve) => server!.close(() => resolve())) : Promise.resolve(),
      ...stops.map((stopJob) => stopJob()),
    ]);
    // Emails after a commit that went out with the answer (an identity request's).
    const unfinished = await settleBackground(BACKGROUND_SECONDS * 1000);
    if (unfinished > 0) logger.warn({ unfinished }, "stopped before background work finished");
    await closeDb();
    await flushErrorReports();
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "startup failed");
  await flushErrorReports();
  process.exit(1);
});
