import { and, desc, eq, gte, inArray, isNotNull, lt, lte, or, isNull } from "drizzle-orm";
import { AdapterKind } from "../adapters/base";
import { addDays, formatDate, today } from "../core/time";
import {
  accounts,
  connections,
  people,
  syncRuns,
  users,
  type Connection,
  type SyncKind,
  type SyncRun,
  type Workflow,
} from "../db/schema";
import { q } from "../db/tx";
import pg from "pg";
import { connectionOptions } from "../db/client";
import { logger } from "../logger";
import { kindOf, syncIntervalMinutes } from "./connections";
import { settleFinishedWorkflows } from "./jobs";
import { LifecycleError, startWorkflow } from "./lifecycle";
import { loadSettings } from "./settings";
import { canCompareAccounts, compareAccounts, importPeople, recoverStoppedReads } from "./sync";

/**
 * What the worker starts on its own: onboarding before start dates,
 * offboarding after end dates, people imports and account comparisons.
 */

/**
 * PostgreSQL advisory locks: one worker at a time runs the schedule, and one
 * at a time reads from connections. With several workers, one can run jobs
 * while another reads a big directory.
 */
export const SCHEDULE_LOCK_ID = 7_340_116_201;
export const SYNC_LOCK_ID = 7_340_116_202;
/**
 * A failed read comes again sooner than its interval: after 15 minutes, then
 * 30, 60 and so on, never later than the interval.
 */
export const SYNC_RETRY_MINUTES = 15;

export async function startDueOnboarding(): Promise<Workflow[]> {
  const settings = await loadSettings();
  if (!settings.automaticOnboarding) return [];
  const horizon = addDays(today(), settings.onboardingLeadDays);
  const due = await q()
    .select()
    .from(people)
    .where(
      and(
        eq(people.status, "planned"),
        isNotNull(people.startDate),
        lte(people.startDate, horizon),
        isNotNull(people.accessProfileId),
        eq(people.onboardingPaused, false),
        or(isNull(people.endDate), gte(people.endDate, today())),
      ),
    )
    .orderBy(people.lastName, people.firstName, people.id);
  const started: Workflow[] = [];
  for (const person of due) {
    try {
      started.push(
        await startWorkflow(person.id, "onboarding", {
          automatic: true,
          reason: `starts on ${formatDate(person.startDate!)}`,
        }),
      );
    } catch (error) {
      // One person must not stop the schedule.
      if (error instanceof LifecycleError)
        logger.info({ personId: person.id, reason: error.message }, "onboarding not started");
      else logger.error({ err: error, personId: person.id }, "onboarding failed to start");
    }
  }
  return started;
}

export async function startDueOffboarding(): Promise<Workflow[]> {
  const settings = await loadSettings();
  if (!settings.automaticOffboarding) return [];
  const due = await q()
    .select()
    .from(people)
    .where(
      and(
        inArray(people.status, ["onboarding", "active", "planned"]),
        isNotNull(people.endDate),
        lt(people.endDate, today()),
      ),
    )
    .orderBy(people.lastName, people.firstName, people.id);
  const started: Workflow[] = [];
  for (const person of due) {
    if (person.status === "planned") {
      const [account] = await q()
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.personId, person.id))
        .limit(1);
      const [user] = await q()
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.personId, person.id), eq(users.isActive, true)))
        .limit(1);
      if (!account && !user) continue;
    }
    try {
      started.push(await startWorkflow(person.id, "offboarding", { automatic: true }));
    } catch (error) {
      if (error instanceof LifecycleError)
        logger.info({ personId: person.id, reason: error.message }, "offboarding not started");
      else logger.error({ err: error, personId: person.id }, "offboarding failed to start");
    }
  }
  return started;
}

/** The read the schedule runs at the connection, if any. */
function syncKind(connection: Connection): SyncKind | null {
  if (kindOf(connection) === AdapterKind.HR_SOURCE) return "people";
  if (kindOf(connection) === AdapterKind.PROVISIONING && canCompareAccounts(connection)) return "accounts";
  return null;
}

/** When the connection's next read is due; null when it never ran. */
async function syncDueAt(connection: Connection, kind: SyncKind): Promise<Date | null> {
  if (connection.lastSyncAt === null) return null;
  const interval = syncIntervalMinutes(connection);
  // Enough runs for the pause after failures to reach the interval.
  const history = Math.max(Math.floor(interval / SYNC_RETRY_MINUTES), 1).toString(2).length + 1;
  const runs = await q()
    .select({ status: syncRuns.status })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connection.id), eq(syncRuns.kind, kind)))
    .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
    .limit(history);
  let failures = 0;
  for (const run of runs) {
    if (run.status !== "failed") break;
    failures += 1;
  }
  const minutes = failures > 0 ? Math.min(interval, SYNC_RETRY_MINUTES * 2 ** (failures - 1)) : interval;
  return new Date(connection.lastSyncAt.getTime() + minutes * 60_000);
}

/** The reads that are due, the most overdue first. */
export async function dueSyncs(): Promise<{ connection: Connection; kind: SyncKind }[]> {
  const now = new Date();
  const due: { dueAt: Date; connection: Connection; kind: SyncKind }[] = [];
  for (const connection of await q().select().from(connections).where(eq(connections.enabled, true))) {
    if (syncIntervalMinutes(connection) <= 0) continue;
    const kind = syncKind(connection);
    if (kind === null) continue;
    const dueAt = (await syncDueAt(connection, kind)) ?? new Date(0);
    if (dueAt <= now) due.push({ dueAt, connection, kind });
  }
  due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.connection.id - b.connection.id);
  return due.map(({ connection, kind }) => ({ connection, kind }));
}

/**
 * Runs the most overdue people import or account comparison. One read per
 * call: a slow connection then holds up the worker's jobs for one read, not
 * for all of them.
 */
export async function runDueSync(): Promise<SyncRun | null> {
  return exclusive(SYNC_LOCK_ID, async () => {
    await recoverStoppedReads();
    const [first] = await dueSyncs();
    if (!first) return null;
    return first.kind === "people" ? importPeople(first.connection) : compareAccounts(first.connection);
  });
}

/**
 * Runs `fn` while this worker holds the lock; null when another one holds
 * it. With several workers, the first one to ask does the work and the
 * others skip it, so nobody starts a workflow twice, counts removals or reads
 * a connection at the same time. The lock lives on a connection of its own,
 * held until `fn` ends.
 */
export async function exclusive<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
  // A connection outside the pool: `fn` needs the pool's connections, even
  // with DATABASE_POOL_SIZE=1. Ending it releases the lock, also after a failure.
  const client = new pg.Client(connectionOptions());
  client.on("error", (error) => logger.warn({ err: error }, "lock connection error"));
  await client.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1) as acquired",
      [lockId],
    );
    if (!rows[0]!.acquired) return null;
    return await fn();
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runSchedule(): Promise<Record<string, number>> {
  const summary = await exclusive(SCHEDULE_LOCK_ID, async () => ({
    onboarding: (await startDueOnboarding()).length,
    offboarding: (await startDueOffboarding()).length,
    settled: await settleFinishedWorkflows(),
  }));
  return summary ?? {};
}
