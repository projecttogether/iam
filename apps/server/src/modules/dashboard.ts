import { Hono } from "hono";
import { and, asc, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import { OPEN_WORKFLOW_STATUSES, PERSON_STATUS_LABELS } from "@iam/shared/labels";
import type { Dashboard, PersonDateRow } from "@iam/shared/api/iam";
import { config } from "../config";
import { addDays, today } from "../core/time";
import {
  connections,
  jobs,
  people,
  tasks,
  workerHeartbeats,
  workflows,
  type PersonStatus,
} from "../db/schema";
import { q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { requireRole } from "../http/middleware";
import { fullName } from "../engine/people";
import { countOf, eventRows } from "./rows";

const router = new Hono<AppEnv>();

router.get("/dashboard", async (c) => {
  requireRole(c, "viewer");
  const day = today();
  const peopleCounts = Object.fromEntries(
    Object.keys(PERSON_STATUS_LABELS).map((status) => [status, 0]),
  ) as Record<PersonStatus, number>;
  for (const person of await q().select({ status: people.status }).from(people)) {
    peopleCounts[person.status] = (peopleCounts[person.status] ?? 0) + 1;
  }
  const leftOut = notInArray(people.status, ["offboarded", "archived"]);
  const dateRows = (rows: (typeof people.$inferSelect)[], date: "startDate" | "endDate"): PersonDateRow[] =>
    rows.map((person) => ({
      id: person.id,
      name: fullName(person),
      date: person[date]!,
      status: person.status,
    }));
  const starting = await q()
    .select()
    .from(people)
    .where(and(gte(people.startDate, day), lte(people.startDate, addDays(day, 30)), leftOut))
    .orderBy(asc(people.startDate), asc(people.lastName), asc(people.firstName))
    .limit(10);
  const leaving = await q()
    .select()
    .from(people)
    .where(and(gte(people.endDate, addDays(day, -1)), lte(people.endDate, addDays(day, 30)), leftOut))
    .orderBy(asc(people.endDate), asc(people.lastName), asc(people.firstName))
    .limit(10);
  const errors = await q()
    .select()
    .from(connections)
    .where(and(eq(connections.enabled, true), eq(connections.status, "error")))
    .orderBy(asc(connections.name));
  const [beat] = await q().select().from(workerHeartbeats).where(eq(workerHeartbeats.name, "worker"));
  const maxAgeSeconds = config().WORKER_HEARTBEAT_MAX_AGE_SECONDS;
  const body: Dashboard = {
    peopleCounts,
    openTasks: await countOf(tasks, eq(tasks.status, "open")),
    failedJobs: await countOf(jobs, eq(jobs.status, "failed")),
    heldJobs: await countOf(jobs, eq(jobs.status, "held")),
    openWorkflows: await countOf(workflows, inArray(workflows.status, [...OPEN_WORKFLOW_STATUSES])),
    connections: await countOf(connections),
    connectionErrors: errors.map((connection) => ({
      id: connection.id,
      name: connection.name,
      message: connection.statusMessage,
    })),
    starting: dateRows(starting, "startDate"),
    leaving: dateRows(leaving, "endDate"),
    recentEvents: await eventRows(undefined, 12),
    worker: {
      stale: !beat || beat.beatAt.getTime() < Date.now() - maxAgeSeconds * 1000,
      beatAt: beat ? beat.beatAt.toISOString() : null,
      maxAgeSeconds,
    },
  };
  return c.json(body);
});

export default router;
