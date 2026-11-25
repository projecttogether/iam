import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { workerHeartbeats } from "../db/schema";
import type { AppEnv } from "../http/env";

const router = new Hono<AppEnv>();

/** The process runs. */
router.get("/-/healthz", (c) => c.text("ok"));

function sameToken(given: string, expected: string): boolean {
  // Security: compare in constant time, so response times tell nothing about the token.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

/** Database and worker health. Details only with the health check token (X-Health-Token). */
router.get("/-/readyz", async (c) => {
  const settings = config();
  const token = c.req.header("x-health-token") ?? "";
  const detailed = Boolean(settings.HEALTHCHECK_TOKEN) && sameToken(token, settings.HEALTHCHECK_TOKEN);
  const checks: Record<string, string> = {};
  let beatAt: Date | null = null;
  try {
    await getDb().execute(sql`select 1`);
    checks.database = "ok";
    const [beat] = await getDb().select().from(workerHeartbeats).where(eq(workerHeartbeats.name, "worker"));
    beatAt = beat?.beatAt ?? null;
  } catch {
    checks.database = "unavailable";
  }
  const maxAge = settings.WORKER_HEARTBEAT_MAX_AGE_SECONDS * 1000;
  checks.worker = beatAt && beatAt.getTime() > Date.now() - maxAge ? "ok" : "stale";
  const healthy = Object.values(checks).every((value) => value === "ok");
  const body: Record<string, unknown> = { status: healthy ? "ok" : "unhealthy" };
  if (detailed) {
    body.checks = checks;
    body.version = settings.APP_VERSION ?? "";
    body.read_only = settings.READ_ONLY;
  }
  c.header("cache-control", "no-store");
  return c.json(body, healthy ? 200 : 503);
});

export default router;
