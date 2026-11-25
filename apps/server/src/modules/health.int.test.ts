import { describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../config";
import { getDb } from "../db/client";
import { workerHeartbeats } from "../db/schema";
import { useEngineFixtures } from "../test/fixtures";
import { request } from "../test/helpers";

/** Port of tests/test_views.py: the readiness check. */

describe("health checks", () => {
  useEngineFixtures();

  it("reports a stale worker, with details only for the health token", async () => {
    overrideConfigForTests({ HEALTHCHECK_TOKEN: "health-token" });
    try {
      const anonymous = await request("GET", "/-/readyz");
      expect(anonymous.status).toBe(503);
      expect(anonymous.body).not.toHaveProperty("checks");
      const detailed = await request("GET", "/-/readyz", { headers: { "x-health-token": "health-token" } });
      expect(detailed.body.checks).toEqual({ database: "ok", worker: "stale" });
      await getDb().insert(workerHeartbeats).values({ name: "worker" });
      expect((await request("GET", "/-/readyz")).status).toBe(200);
    } finally {
      overrideConfigForTests({ HEALTHCHECK_TOKEN: "" });
    }
  });
});
