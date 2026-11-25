import { asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Adapter,
  AdapterKind,
  ConfigurationError,
  ensureResult,
  externalAccount,
  TransientError,
  type HRRecord,
  type TestResult,
} from "../adapters/base";
import { registerAdapterForTests } from "../adapters/registry";
import { addDays, today } from "../core/time";
import { getDb } from "../db/client";
import {
  accessProfiles,
  accounts,
  appSettings,
  connections,
  jobs,
  people,
  providerGroups,
  syncRuns,
  teams,
  users,
  workerHeartbeats,
  type Connection,
  type Person,
  type SyncRun,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import { TEST_DATABASE_URL } from "../test/env";
import { STORE, type FakeAccount } from "../test/fake-adapter";
import { makeConnection, makePerson, makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { noteProgress } from "../worker/liveness";
import { PROGRESS_SECONDS, Worker } from "../worker";
import { accountSeams, recordJobResult, recordListing } from "./accounts";
import { loadJob, locked } from "./jobs";
import { startWorkflow } from "./lifecycle";
import type * as LifecycleModule from "./lifecycle";
import type * as ScheduleModule from "./schedule";
import {
  runDueSync,
  runSchedule,
  SCHEDULE_LOCK_ID,
  startDueOffboarding,
  startDueOnboarding,
  SYNC_LOCK_ID,
} from "./schedule";
import { compareAccounts, importGroups, importPeople, importRecord } from "./sync";

/** Port of tests/test_sync.py: group import, account comparison, drift, people import, the schedule's reads. */

/**
 * Python monkeypatches module functions (run_worker.run_due_sync,
 * run_worker.run_schedule, schedule.start_workflow): the worker and the
 * schedule call these through the mocks below, which use a hook while a test
 * sets one.
 */
const hooks = vi.hoisted(() => ({
  runDueSync: null as null | (() => Promise<SyncRun | null>),
  runSchedule: null as null | (() => Promise<Record<string, number>>),
  startWorkflow: null as null | ((...args: never[]) => Promise<unknown>),
}));
vi.mock("./schedule", async (importOriginal) => {
  const actual = await importOriginal<typeof ScheduleModule>();
  return {
    ...actual,
    runDueSync: () => (hooks.runDueSync ?? actual.runDueSync)(),
    runSchedule: () => (hooks.runSchedule ?? actual.runSchedule)(),
  };
});
vi.mock("./lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof LifecycleModule>();
  type Args = Parameters<typeof actual.startWorkflow>;
  return {
    ...actual,
    startWorkflow: (...args: Args) =>
      hooks.startWorkflow
        ? (hooks.startWorkflow as (...a: Args) => ReturnType<typeof actual.startWorkflow>)(...args)
        : actual.startWorkflow(...args),
  };
});

// -- helpers --------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function listedAccount(values: Pick<FakeAccount, "username" | "email">): FakeAccount {
  return { active: true, groups: new Set(), ...values };
}

async function personRow(id: number): Promise<Person> {
  const [row] = await getDb().select().from(people).where(eq(people.id, id));
  return row!;
}

async function accountByExternalId(externalId: string) {
  const [row] = await getDb().select().from(accounts).where(eq(accounts.externalId, externalId));
  return row!;
}

async function updatePerson(id: number, values: Partial<typeof people.$inferInsert>) {
  await getDb().update(people).set(values).where(eq(people.id, id));
}

async function updateConnection(id: number, values: Partial<typeof connections.$inferInsert>) {
  await getDb().update(connections).set(values).where(eq(connections.id, id));
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** run_worker --once: one round of the worker, with the schedule due. */
async function runWorkerOnce(): Promise<void> {
  await new Worker().round({ scheduleDue: true });
}

/**
 * Runs `change` in another transaction that holds its row locks for half a
 * second, as a job or workflow committing at the same time would. Returns
 * once the change is made; `join` waits for the commit.
 */
async function changeMeanwhile(change: () => Promise<unknown>): Promise<{ join: () => Promise<void> }> {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const thread = atomic(async () => {
    await change();
    started();
    await sleep(500);
  });
  await Promise.race([
    ready,
    thread.then(() => {
      throw new Error("The change ended before it started");
    }),
    sleep(5000).then(() => {
      throw new Error("The change did not start");
    }),
  ]);
  return { join: () => thread };
}

/** Another database connection, as another worker holds it. */
async function otherConnection(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  return client;
}

// -- the fake HR adapter of the Python tests (hr_connection) ---------------------------------

const FAKE_HR = { records: [] as HRRecord[] };

class HRAdapter extends Adapter {
  static override readonly slug = "fake_hr";
  static override readonly label = "Fake HR";
  static override readonly kind = AdapterKind.HR_SOURCE;
  static override readonly supportsWrite = false;

  override async testConnection(): Promise<TestResult> {
    return { ok: true, message: "" };
  }

  override async listPeople(): Promise<HRRecord[]> {
    return [...FAKE_HR.records];
  }
}

function hrRecord(
  values: Partial<HRRecord> & Pick<HRRecord, "externalId" | "firstName" | "lastName">,
): HRRecord {
  return {
    workEmail: "",
    personalEmail: "",
    jobTitle: "",
    personType: "",
    team: "",
    managerEmail: "",
    startDate: null,
    endDate: null,
    active: true,
    ...values,
  };
}

async function makeHrConnection(): Promise<Connection> {
  return makeConnection({
    adapter: "fake_hr",
    name: "HR",
    enabled: true,
    settings: { sync_interval_minutes: 60 },
    secretData: "",
  });
}

/** A person record without a work email, as Person.objects.create(first_name=..., last_name=...) makes. */
function otherPerson(values: Partial<typeof people.$inferInsert>): Promise<Person> {
  return makePerson({ workEmail: null, personalEmail: "", ...values });
}

type Summary = Record<string, unknown> & {
  new_links: number;
  missing: number;
  accounts: number;
  unlinked_active: number;
  missing_access: unknown[];
  unexpected_access: unknown[];
};
const summaryOf = (run: SyncRun) => run.summary as Summary;

describe("reads from connections", () => {
  useEngineFixtures();
  let unregister: () => void;
  beforeAll(() => {
    unregister = registerAdapterForTests(HRAdapter as never);
  });
  afterAll(() => unregister());
  beforeEach(() => {
    FAKE_HR.records = [];
  });
  afterEach(() => {
    hooks.runDueSync = null;
    hooks.runSchedule = null;
    hooks.startWorkflow = null;
    vi.restoreAllMocks();
    noteProgress();
  });

  it("imports groups: creates, updates and marks missing", async () => {
    const connection = await makeConnection();
    const [stale] = await getDb()
      .insert(providerGroups)
      .values({ connectionId: connection.id, externalId: "gone", name: "Gone" })
      .returning();
    const run = await importGroups(connection);
    expect(run.status).toBe("succeeded");
    expect(run.summary).toEqual({ groups: 3, created: 3, updated: 0, missing: 1 });
    const [refreshed] = await getDb().select().from(providerGroups).where(eq(providerGroups.id, stale!.id));
    expect(refreshed!.missing).toBe(true);
    const [eng] = await getDb().select().from(providerGroups).where(eq(providerGroups.externalId, "g-eng"));
    expect(eng!.path).toBe("/Engineering");
  });

  it("records failed reads instead of throwing", async () => {
    const connection = await makeConnection();
    STORE.failWith = new ConfigurationError("Token refused.");
    const run = await compareAccounts(connection);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Token refused.");
  });

  // As a job decides: a username can belong to someone else (another J.
  // Smith), and an email that is not the person's shows it does.
  it.each([
    ["ada", "ada.byron@example.invalid", false],
    ["ADA@example.invalid", "ada.byron@example.invalid", false],
    ["ada", "", true],
    ["ada", "Ada@Example.invalid", true],
  ] as const)(
    "never links a username with another email in an account comparison (%s, %s)",
    async (username, email, linked) => {
      const { connection, person } = await standardSetup();
      await updatePerson(person.id, { username: "ada" });
      STORE.accounts.set("x1", listedAccount({ username, email }));
      const run = await compareAccounts(connection);
      expect((await accountByExternalId("x1")).personId === person.id).toBe(linked);
      expect(summaryOf(run).new_links).toBe(Number(linked));
    },
  );

  it("links by email and reports drift in an account comparison", async () => {
    const { connection, person } = await standardSetup();
    STORE.accounts.set("x1", listedAccount({ username: "ada", email: "ADA@example.invalid" }));
    STORE.accounts.set("x2", listedAccount({ username: "stranger", email: "stranger@example.invalid" }));
    const [gone] = await getDb()
      .insert(accounts)
      .values({ connectionId: connection.id, externalId: "old", status: "active" })
      .returning();
    await updatePerson(person.id, { status: "offboarded" });
    const run = await compareAccounts(connection);
    expect(run.status).toBe("succeeded");
    expect((await accountByExternalId("x1")).personId).toBe(person.id);
    expect((await accountByExternalId("x2")).personId).toBeNull();
    expect((await accountByExternalId(gone!.externalId)).status).toBe("missing");
    expect(summaryOf(run).new_links).toBe(1);
    expect(summaryOf(run).unlinked_active).toBe(1);
    expect(summaryOf(run).unexpected_access).toEqual([
      { id: person.id, name: "Ada Lovelace", status: "offboarded" },
    ]);
  });

  it("does not record a listing without most accounts", async () => {
    const connection = await makeConnection();
    const admin = await makeUser("admin");
    for (let n = 0; n < 15; n += 1) {
      STORE.accounts.set(`x${n}`, listedAccount({ username: `user${n}`, email: "" }));
    }
    expect(summaryOf(await compareAccounts(connection)).accounts).toBe(15);
    // A few accounts really are gone.
    for (let n = 0; n < 3; n += 1) STORE.accounts.delete(`x${n}`);
    expect(summaryOf(await compareAccounts(connection)).missing).toBe(3);
    // An answer that only seems empty.
    const saved = STORE.accounts;
    STORE.accounts = new Map();
    let run = await compareAccounts(connection);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("listed 0 accounts, without 12 of the 12");
    expect((await getDb().select().from(accounts).where(eq(accounts.status, "active"))).length).toBe(12);
    // An admin who knows they are gone records it.
    run = await compareAccounts(connection, admin);
    expect(run.status).toBe("succeeded");
    expect(summaryOf(run).missing).toBe(12);
    STORE.accounts = saved;
  });

  it("reports missing access in an account comparison", async () => {
    const { connection, person } = await standardSetup();
    await updatePerson(person.id, { status: "active" });
    const run = await compareAccounts(connection);
    expect(summaryOf(run).missing_access).toEqual([{ id: person.id, name: "Ada Lovelace" }]);
  });

  it("creates and updates people in a people import", async () => {
    const hr = await makeHrConnection();
    const [staff] = await getDb()
      .insert(accessProfiles)
      .values({ name: "Staff", defaultFor: ["employee"] })
      .returning();
    const [team] = await getDb().insert(teams).values({ name: "Product" }).returning();
    const manager = await otherPerson({
      firstName: "Grace",
      lastName: "Hopper",
      workEmail: "grace@example.invalid",
    });
    const start = addDays(today(), 10);
    FAKE_HR.records = [
      hrRecord({
        externalId: "42",
        firstName: "Ada",
        lastName: "Lovelace",
        workEmail: "Ada@example.invalid",
        personType: "employee",
        team: "product",
        managerEmail: "grace@example.invalid",
        startDate: start,
      }),
      hrRecord({ externalId: "43", firstName: "Left", lastName: "Long Ago", active: false }),
    ];
    let run = await importPeople(hr);
    expect(run.status, run.error).toBe("succeeded");
    const [ada] = await getDb().select().from(people).where(eq(people.sourceId, "42"));
    expect([ada!.workEmail, ada!.teamId, ada!.managerId, ada!.accessProfileId, ada!.startDate]).toEqual([
      "ada@example.invalid",
      team!.id,
      manager.id,
      staff!.id,
      start,
    ]);
    expect(ada!.status).toBe("planned");
    expect(await getDb().select().from(people).where(eq(people.sourceId, "43"))).toEqual([]);
    FAKE_HR.records[0]!.endDate = addDays(start, 90);
    FAKE_HR.records[0]!.workEmail = "ada.new@example.invalid";
    run = await importPeople(hr);
    const updated = await personRow(ada!.id);
    expect(updated.endDate).toBe(addDays(start, 90));
    expect(updated.workEmail, "a work email never changes by import").toBe("ada@example.invalid");
    const summary = run.summary as { work_email_differs: { id: number }[]; updated: { fields: string[] }[] };
    expect(summary.work_email_differs[0]!.id).toBe(ada!.id);
    expect(summary.updated[0]!.fields).toEqual(["end_date"]);
  });

  it("claims existing people by work email in a people import", async () => {
    const hr = await makeHrConnection();
    const existing = await otherPerson({ firstName: "Ada", lastName: "L", workEmail: "ada@example.invalid" });
    FAKE_HR.records = [
      hrRecord({ externalId: "7", firstName: "Ada", lastName: "Lovelace", workEmail: "ada@example.invalid" }),
    ];
    await importPeople(hr);
    const claimed = await personRow(existing.id);
    expect([claimed.sourceConnectionId, claimed.sourceId, claimed.lastName]).toEqual([
      hr.id,
      "7",
      "Lovelace",
    ]);
  });

  it("reports people missing from HR and does not offboard them", async () => {
    const hr = await makeHrConnection();
    const person = await otherPerson({
      firstName: "Ada",
      lastName: "Lovelace",
      status: "active",
      sourceConnectionId: hr.id,
      sourceId: "9",
    });
    FAKE_HR.records = [];
    const run = await importPeople(hr);
    expect((await personRow(person.id)).status).toBe("active");
    expect((run.summary as { not_listed: unknown[] }).not_listed).toEqual([
      { id: person.id, name: "Ada Lovelace" },
    ]);
  });

  it("starts onboarding within the lead time", async () => {
    const { person } = await standardSetup();
    await updatePerson(person.id, { startDate: addDays(today(), 3) });
    const later = await otherPerson({
      firstName: "Later",
      lastName: "Person",
      accessProfileId: person.accessProfileId,
      startDate: addDays(today(), 30),
    });
    const started = await startDueOnboarding();
    expect(started.map((workflow) => workflow.personId)).toEqual([person.id]);
    expect(started[0]!.automatic).toBe(true);
    expect((await personRow(later.id)).status).toBe("planned");
  });

  it("respects the automatic onboarding switch", async () => {
    const { person } = await standardSetup();
    await getDb()
      .insert(appSettings)
      .values({ id: 1, automaticOnboarding: false })
      .onConflictDoUpdate({ target: appSettings.id, set: { automaticOnboarding: false } });
    await updatePerson(person.id, { startDate: today() });
    expect(await startDueOnboarding()).toEqual([]);
  });

  it("offboards the day after the last day", async () => {
    const { person } = await standardSetup();
    await updatePerson(person.id, { status: "active", endDate: today() });
    expect(await startDueOffboarding()).toEqual([]);
    await updatePerson(person.id, { endDate: addDays(today(), -1) });
    const started = await startDueOffboarding();
    expect(started).toHaveLength(1);
    expect(started[0]!.kind).toBe("offboarding");
  });

  it("runs due syncs on their interval", async () => {
    const connection = await makeConnection();
    await updateConnection(connection.id, { settings: { sync_interval_minutes: 30 } });
    expect((await runDueSync())?.kind).toBe("accounts");
    expect(await runDueSync()).toBeNull();
    await updateConnection(connection.id, { lastSyncAt: minutesAgo(31) });
    expect(await runDueSync()).not.toBeNull();
  });

  it("runs a failed read again sooner than its interval", async () => {
    const connection = await makeConnection();
    await updateConnection(connection.id, { settings: { sync_interval_minutes: 360 } });
    STORE.failWith = new TransientError("Fake app answered 503.");
    const ago = (minutes: number) => updateConnection(connection.id, { lastSyncAt: minutesAgo(minutes) });
    expect((await runDueSync())?.status).toBe("failed");
    await ago(14);
    expect(await runDueSync()).toBeNull();
    await ago(16);
    expect((await runDueSync())?.status).toBe("failed");
    // Each failure waits twice as long, and never longer than the interval.
    await ago(29);
    expect(await runDueSync()).toBeNull();
    await ago(31);
    STORE.failWith = null;
    expect((await runDueSync())?.status).toBe("succeeded");
    await ago(300);
    expect(await runDueSync()).toBeNull();
  });

  it("reaches a long interval after enough failures", async () => {
    const connection = await makeConnection();
    await updateConnection(connection.id, { settings: { sync_interval_minutes: 1440 } });
    const start = Date.now() - 3 * 24 * 3600 * 1000;
    for (let n = 0; n < 8; n += 1) {
      await getDb()
        .insert(syncRuns)
        .values({
          connectionId: connection.id,
          kind: "accounts",
          status: "failed",
          startedAt: new Date(start + n * 60_000),
        });
    }
    await updateConnection(connection.id, { lastSyncAt: minutesAgo(1000) });
    expect(await runDueSync(), "a daily read that keeps failing runs once a day").toBeNull();
  });

  it("lets a read that stopped its worker wait its turn", async () => {
    const connection = await makeConnection();
    const hr = await makeHrConnection();
    const admin = await makeUser("admin");
    await updateConnection(connection.id, {
      settings: { sync_interval_minutes: 60 },
      lastSyncAt: minutesAgo(5 * 60),
    });
    await updateConnection(hr.id, { lastSyncAt: minutesAgo(90) });
    // The worker died during the comparison, e.g. ended by its watchdog.
    const [stopped] = await getDb()
      .insert(syncRuns)
      .values({ connectionId: connection.id, kind: "accounts" })
      .returning();
    const [byAdmin] = await getDb()
      .insert(syncRuns)
      .values({ connectionId: hr.id, kind: "people", triggeredById: admin.id })
      .returning();
    expect((await runDueSync())?.connectionId).toBe(hr.id);
    const [stoppedNow] = await getDb().select().from(syncRuns).where(eq(syncRuns.id, stopped!.id));
    expect(stoppedNow!.status).toBe("failed");
    expect(stoppedNow!.finishedAt).not.toBeNull();
    expect(await runDueSync(), "the stopped read pauses as after any failure").toBeNull();
    const [byAdminNow] = await getDb().select().from(syncRuns).where(eq(syncRuns.id, byAdmin!.id));
    expect(byAdminNow!.status, "a read a person started is left alone").toBe("running");
  });

  it("runs one read per round, the most overdue first", async () => {
    const connection = await makeConnection();
    const hr = await makeHrConnection();
    await updateConnection(connection.id, {
      settings: { sync_interval_minutes: 60 },
      lastSyncAt: minutesAgo(90),
    });
    await updateConnection(hr.id, { lastSyncAt: minutesAgo(120) });
    expect((await runDueSync())?.connectionId).toBe(hr.id);
    expect((await runDueSync())?.connectionId).toBe(connection.id);
    expect(await runDueSync()).toBeNull();
  });

  it("runs the jobs before a read in the worker", async () => {
    const { person } = await standardSetup();
    const seen: string[] = [];
    hooks.runDueSync = async () => {
      const rows = await getDb().select({ status: jobs.status }).from(jobs);
      expect(rows).toHaveLength(1);
      seen.push(rows[0]!.status);
      return null;
    };
    await startWorkflow(person.id, "onboarding");
    await runWorkerOnce();
    expect(seen).toEqual(["succeeded"]);
  });

  it("runs jobs and beats in the worker", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runWorkerOnce();
    const rows = await getDb().select({ status: jobs.status }).from(jobs);
    expect(rows).toEqual([{ status: "succeeded" }]);
    expect(
      await getDb().select().from(workerHeartbeats).where(eq(workerHeartbeats.name, "worker")),
    ).toHaveLength(1);
  });

  it("goes on beating during long work only while the worker gets answers", async () => {
    const worker = new Worker();
    const internals = worker as unknown as { lastBeat: number | null };
    internals.lastBeat = null;
    noteProgress(); // e.g. a page of a long listing arrived
    expect(await worker.beatIfProgressing()).toBe(true);
    const [beat] = await getDb().select().from(workerHeartbeats).where(eq(workerHeartbeats.name, "worker"));
    internals.lastBeat = null;
    // Python: liveness._last_progress = time.monotonic() - PROGRESS_SECONDS.
    const now = performance.now();
    const spy = vi.spyOn(performance, "now").mockReturnValue(now - PROGRESS_SECONDS * 1000);
    noteProgress();
    spy.mockRestore();
    expect(await worker.beatIfProgressing(), "a stuck worker stops beating").toBe(false);
    const [after] = await getDb().select().from(workerHeartbeats).where(eq(workerHeartbeats.name, "worker"));
    expect(after!.beatAt).toEqual(beat!.beatAt);
  });

  it("does not stop the schedule for one failing person", async () => {
    const { person } = await standardSetup();
    const other = await makePerson({
      firstName: "Grace",
      lastName: "Hopper",
      workEmail: "grace@example.invalid",
      personalEmail: "",
      accessProfileId: person.accessProfileId,
      startDate: today(),
    });
    await updatePerson(person.id, { startDate: today() });
    const { startWorkflow: original } = await vi.importActual<typeof LifecycleModule>("./lifecycle");
    hooks.startWorkflow = ((personId: number, ...rest: [never, never]) => {
      if (personId === person.id) throw new Error("database hiccup");
      return original(personId, ...rest);
    }) as never;
    const started = await startDueOnboarding();
    expect(started.map((workflow) => workflow.personId)).toEqual([other.id]);
  });

  it("does not stop the jobs for a failing schedule", async () => {
    const { person } = await standardSetup();
    hooks.runSchedule = async () => {
      throw new Error("schedule broke");
    };
    await startWorkflow(person.id, "onboarding");
    await runWorkerOnce();
    expect(await getDb().select({ status: jobs.status }).from(jobs)).toEqual([{ status: "succeeded" }]);
  });

  it("lets one worker at a time run the schedule", async () => {
    const { person } = await standardSetup();
    await updatePerson(person.id, { startDate: today() });
    const other = await otherConnection();
    try {
      await other.query("select pg_advisory_lock($1)", [SCHEDULE_LOCK_ID]);
      expect(await runSchedule()).toEqual({});
      expect((await personRow(person.id)).status).toBe("planned");
    } finally {
      await other.end();
    }
    expect((await runSchedule()).onboarding).toBe(1);
  });

  it("lets a worker that reads hold up neither the schedule nor other reads", async () => {
    const { connection, person } = await standardSetup();
    await updateConnection(connection.id, { settings: { sync_interval_minutes: 60 } });
    await updatePerson(person.id, { startDate: today() });
    const other = await otherConnection();
    try {
      await other.query("select pg_advisory_lock($1)", [SYNC_LOCK_ID]);
      expect(await runDueSync(), "another worker is reading").toBeNull();
      expect((await runSchedule()).onboarding).toBe(1);
    } finally {
      await other.end();
    }
    expect(await runDueSync()).not.toBeNull();
  });

  it("reports planned people with active accounts as drift", async () => {
    const { connection, person } = await standardSetup();
    STORE.accounts.set("x1", listedAccount({ username: "ada", email: "ada@example.invalid" }));
    const run = await compareAccounts(connection);
    expect(summaryOf(run).unexpected_access).toEqual([
      { id: person.id, name: "Ada Lovelace", status: "planned" },
    ]);
  });

  it("offboards a planned person with an app user", async () => {
    const { person } = await standardSetup();
    const user = await makeUser("viewer", "ada@example.invalid", { personId: person.id });
    await updatePerson(person.id, { endDate: addDays(today(), -1) });
    expect(await startDueOffboarding()).toHaveLength(1);
    const [after] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(after!.isActive).toBe(false);
  });

  it("lifts a paused onboarding with a new start date from the HR import", async () => {
    const { person } = await standardSetup();
    await updatePerson(person.id, { onboardingPaused: true, sourceId: "p1" });
    const connection = await makeConnection({
      adapter: "personio",
      name: "Personio",
      enabled: false,
      secretData: "",
    });
    await updatePerson(person.id, { sourceConnectionId: connection.id });
    const record = hrRecord({
      externalId: "p1",
      firstName: "Ada",
      lastName: "Lovelace",
      workEmail: "ada@example.invalid",
      startDate: "2027-01-04",
    });
    const summary = { work_email_differs: [], updated: [], inactive_without_end_date: [] };
    await importRecord(connection, record, summary as unknown as Parameters<typeof importRecord>[2], null);
    const after = await personRow(person.id);
    expect(after.onboardingPaused).toBe(false);
    expect(after.startDate).toBe("2027-01-04");
  });

  it("records an account listed twice once", async () => {
    const connection = await makeConnection();
    const twice = externalAccount("x1", { username: "ada", email: "ada@example.invalid" });
    const summary = await recordListing(connection, [twice, twice]);
    expect(summary.accounts).toBe(1);
    expect(await getDb().select().from(accounts).where(eq(accounts.externalId, "x1"))).toHaveLength(1);
  });

  it("keeps the groups a job records meanwhile in a comparison", async () => {
    const { connection, person } = await standardSetup();
    const [account] = await getDb()
      .insert(accounts)
      .values({
        connectionId: connection.id,
        externalId: "x1",
        personId: person.id,
        appliedGroups: ["g-staff"],
      })
      .returning();
    const thread = await changeMeanwhile(() =>
      q()
        .update(accounts)
        .set({ appliedGroups: ["g-eng", "g-staff"] })
        .where(eq(accounts.id, account!.id)),
    );
    await recordListing(connection, [externalAccount("x1", { username: "ada" })]);
    await thread.join();
    expect((await accountByExternalId("x1")).appliedGroups).toEqual(["g-eng", "g-staff"]);
  });

  it("keeps a status a workflow sets meanwhile in the HR import", async () => {
    const { person } = await standardSetup();
    const connection = await makeConnection({
      adapter: "personio",
      name: "Personio",
      enabled: false,
      secretData: "",
    });
    await updatePerson(person.id, { status: "active", sourceConnectionId: connection.id, sourceId: "p1" });
    const thread = await changeMeanwhile(() =>
      q().update(people).set({ status: "offboarding" }).where(eq(people.id, person.id)),
    );
    const record = hrRecord({ externalId: "p1", firstName: "Ada", lastName: "King" });
    const summary = { work_email_differs: [], updated: [], inactive_without_end_date: [] };
    // As importPeople runs each record.
    await atomic(() =>
      importRecord(connection, record, summary as unknown as Parameters<typeof importRecord>[2], null),
    );
    await thread.join();
    const after = await personRow(person.id);
    expect(after.lastName).toBe("King");
    expect(after.status).toBe("offboarding");
  });

  it("locks only account rows in a comparison", async () => {
    const { connection } = await standardSetup();
    await getDb().insert(accounts).values({ connectionId: connection.id, externalId: "x1", username: "ada" });
    STORE.accounts.set("x1", listedAccount({ username: "ada", email: "ada@example.invalid" }));
    const queries: string[] = [];
    const original = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const [first] = args;
      queries.push(typeof first === "string" ? first : ((first as { text?: string } | null)?.text ?? ""));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    await compareAccounts(connection);
    vi.restoreAllMocks();
    // Python's SQL says FOR UPDATE OF "iam_account"; drizzle writes it in lower case.
    const locking = queries.filter((text) => /for update/i.test(text));
    expect(locking.length, JSON.stringify(locking)).toBeGreaterThan(0);
    expect(
      locking.every((text) => /for update of "iam_account"/i.test(text)),
      JSON.stringify(locking),
    ).toBe(true);
  });

  it("links an account in a comparison while a job holds the person", async () => {
    const { connection, person } = await standardSetup();
    const workflow = await startWorkflow(person.id, "onboarding");
    const [job] = await getDb().select().from(jobs).where(eq(jobs.workflowId, workflow.id));
    // A job holds the person, as when it records its account; the comparison
    // links an account to that person meanwhile (a foreign-key check).
    const thread = await changeMeanwhile(() => locked(job!));
    const listed = [externalAccount("x1", { username: "ada", email: "ada@example.invalid" })];
    await atomic(async () => {
      await q().execute(sql`set local lock_timeout = '200ms'`);
      await recordListing(connection, listed);
    });
    await thread.join();
    expect((await accountByExternalId("x1")).personId).toBe(person.id);
  });

  it("replaces a placeholder in a comparison and a job at once without deadlock", async () => {
    // A manual change left a placeholder row; a job and a comparison both
    // replace it with the listed account at the same time.
    const { connection, person } = await standardSetup();
    await getDb().insert(accounts).values({ connectionId: connection.id, personId: person.id }); // the placeholder
    await getDb().insert(accounts).values({ connectionId: connection.id, externalId: "x1", username: "ada" });
    const workflow = await startWorkflow(person.id, "onboarding");
    const [row] = await getDb().select().from(jobs).where(eq(jobs.workflowId, workflow.id));
    const job = (await loadJob(row!.id))!;
    let compared!: () => void;
    const comparedNow = new Promise<void>((resolve) => (compared = resolve));
    let jobDone!: () => void;
    const jobDoneNow = new Promise<void>((resolve) => (jobDone = resolve));
    const matchPerson = accountSeams.matchPerson;
    // The comparison holds its account locks; let the job go first. (Python
    // waits until the job replaced the placeholder; here until the job is done.)
    accountSeams.matchPerson = async (connectionId, external) => {
      compared();
      await Promise.race([jobDoneNow, sleep(1500)]);
      return matchPerson(connectionId, external);
    };
    const errors: [string, unknown][] = [];
    const run = (name: string, work: () => Promise<unknown>) =>
      atomic(work).then(
        () => undefined,
        (error: unknown) => {
          errors.push([name, error]);
        },
      );
    try {
      const listed = [externalAccount("x1", { username: "ada", email: "ada@example.invalid" })];
      const comparison = run("comparison", () => recordListing(connection, listed));
      await Promise.race([
        comparedNow,
        sleep(5000).then(() => {
          throw new Error("The comparison did not get to matching");
        }),
      ]);
      const result = ensureResult(externalAccount("x1", { username: "ada" }));
      const worker = run("job", () => recordJobResult(job, result)).finally(() => jobDone());
      await comparison;
      await worker;
    } finally {
      accountSeams.matchPerson = matchPerson;
    }
    expect(errors).toEqual([]);
    const rows = await getDb()
      .select({ externalId: accounts.externalId, personId: accounts.personId })
      .from(accounts)
      .orderBy(asc(accounts.id));
    expect(rows.map((account) => [account.externalId, account.personId])).toEqual([["x1", person.id]]);
  });
});
