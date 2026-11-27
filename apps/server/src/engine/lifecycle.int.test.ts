import { and, asc, desc, eq } from "drizzle-orm";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_WORKFLOW_STATUSES } from "@iam/shared/labels";
import { ensureResult, externalAccount } from "../adapters/base";
import { addDays, today } from "../core/time";
import { getDb } from "../db/client";
import {
  accounts,
  appSettings,
  auditEvents,
  connections,
  jobs,
  people,
  profileGrantGroups,
  profileGrants,
  providerGroups,
  tasks,
  users,
  workflows,
  type Job,
  type TaskKind,
  type TaskStatus,
} from "../db/schema";
import { AdapterError, FakeAdapter, STORE, TransientError } from "../test/fake-adapter";
import {
  grant,
  makeConnection,
  makePerson,
  makeTeam,
  makeUser,
  standardSetup,
  useEngineFixtures,
} from "../test/fixtures";
import { sendEmail } from "./email";
import type * as Email from "./email";
import {
  ActionError,
  approveJob,
  attempt,
  cancelJob,
  cancelTask,
  claimNextJob,
  completeTask,
  finish,
  loadJob,
  MAX_ATTEMPTS,
  recoverStaleJobs,
  rejectJob,
  retryJob,
  runJob,
  seams,
} from "./jobs";
import { archivePerson, cancelWorkflow, LifecycleError, startWorkflow } from "./lifecycle";
import { desiredAccess, managedGroupIds, snapshot } from "./policy";
import { runSchedule, startDueOnboarding } from "./schedule";
import { loadSettings } from "./settings";

/**
 * Port of tests/test_lifecycle.py: workflows, jobs, tasks and the schedule.
 * Each test keeps the name of its Python original (without `test_`).
 */

// Python's monkeypatch of iam.jobs.send_email: the engine sends through this mock.
vi.mock("./email", async (importOriginal) => {
  const actual = await importOriginal<typeof Email>();
  return { ...actual, sendEmail: vi.fn(actual.sendEmail) };
});
const actualEmail = await vi.importActual<typeof Email>("./email");

/** Every email the engine sends from now on in this test, as `record` keeps it; none leaves the app. */
function captureEmails<T>(record: (to: string[], subject: string, body: string) => T): T[] {
  const sent: T[] = [];
  vi.mocked(sendEmail).mockImplementation(async (to, subject, body) => {
    sent.push(record(to, subject, body));
    return true;
  });
  return sent;
}

const db = () => getDb();

function one<T>(rows: T[]): T {
  expect(rows, "exactly one row").toHaveLength(1);
  return rows[0]!;
}

async function runAll() {
  for (let job = await claimNextJob(); job !== null; job = await claimNextJob()) await runJob(job);
}

async function getPerson(id: number) {
  return one(await db().select().from(people).where(eq(people.id, id)));
}

async function getWorkflow(id: number) {
  return one(await db().select().from(workflows).where(eq(workflows.id, id)));
}

async function getJob(id: number) {
  return one(await db().select().from(jobs).where(eq(jobs.id, id)));
}

async function getTask(id: number) {
  return one(await db().select().from(tasks).where(eq(tasks.id, id)));
}

async function getUser(id: number) {
  return one(await db().select().from(users).where(eq(users.id, id)));
}

async function jobsOf(workflowId: number) {
  return db().select().from(jobs).where(eq(jobs.workflowId, workflowId)).orderBy(asc(jobs.id));
}

/** `workflow.jobs.get()` */
async function jobOf(workflowId: number) {
  return one(await jobsOf(workflowId));
}

/** `Job.objects.get()` */
async function onlyJob() {
  return one(await db().select().from(jobs));
}

async function allTasks() {
  return db().select().from(tasks).orderBy(asc(tasks.id));
}

async function tasksWhere(filter: { jobId?: number; kind?: TaskKind; status?: TaskStatus } = {}) {
  return db()
    .select()
    .from(tasks)
    .where(
      and(
        filter.jobId === undefined ? undefined : eq(tasks.jobId, filter.jobId),
        filter.kind === undefined ? undefined : eq(tasks.kind, filter.kind),
        filter.status === undefined ? undefined : eq(tasks.status, filter.status),
      ),
    )
    .orderBy(asc(tasks.id));
}

async function accountOf(personId: number) {
  return one(await db().select().from(accounts).where(eq(accounts.personId, personId)));
}

async function auditOf(action: string, targetId?: number) {
  return db()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, action),
        targetId === undefined ? undefined : eq(auditEvents.targetId, String(targetId)),
      ),
    )
    .orderBy(asc(auditEvents.id));
}

async function setPerson(id: number, values: Partial<typeof people.$inferInsert>) {
  await db().update(people).set(values).where(eq(people.id, id));
}

async function setJob(id: number, values: Partial<typeof jobs.$inferInsert>) {
  await db().update(jobs).set(values).where(eq(jobs.id, id));
}

async function setConnection(id: number, values: Partial<typeof connections.$inferInsert>) {
  await db().update(connections).set(values).where(eq(connections.id, id));
}

/** `profile.grants.all().delete()` */
async function deleteGrants(profileId: number) {
  await db().delete(profileGrants).where(eq(profileGrants.profileId, profileId));
}

/** `profile.grants.get().groups.clear()` */
async function clearGrantGroups(profileId: number) {
  const row = one(await db().select().from(profileGrants).where(eq(profileGrants.profileId, profileId)));
  await db().delete(profileGrantGroups).where(eq(profileGrantGroups.profileGrantId, row.id));
}

/** `AppSettings.objects.update_or_create(pk=1, defaults={"removal_limit_per_day": limit})` */
async function setRemovalLimit(limit: number) {
  await loadSettings();
  await db().update(appSettings).set({ removalLimitPerDay: limit }).where(eq(appSettings.id, 1));
}

const aSecondAgo = () => new Date(Date.now() - 1000);
const isOpen = (status: string) => (OPEN_WORKFLOW_STATUSES as readonly string[]).includes(status);
const allActive = () => [...STORE.accounts.values()].every((data) => data.active);

/** `pytest.raises(cls, match=pattern)` */
async function expectRaises(
  action: Promise<unknown>,
  cls: abstract new (...args: never[]) => Error,
  match?: RegExp,
) {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `raises ${cls.name}`).toBeInstanceOf(cls);
  if (match) expect((error as Error).message).toMatch(match);
}

/**
 * The SQL that reached PostgreSQL while `action` ran (Django's
 * CaptureQueriesContext). Drizzle writes keywords in lower case.
 */
async function captureQueries(action: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(pg.Client.prototype, "query");
  try {
    await action();
    return spy.mock.calls.map(([query]) =>
      typeof query === "string" ? query : (query as { text: string }).text,
    );
  } finally {
    spy.mockRestore();
  }
}

describe("workflows, jobs and tasks (test_lifecycle.py)", () => {
  useEngineFixtures();

  beforeEach(() => {
    vi.mocked(sendEmail).mockImplementation(actualEmail.sendEmail);
  });

  it("desired access combines profile and team groups", async () => {
    const { person, connection } = await standardSetup();
    const access = await desiredAccess({ ...person, status: "active" });
    const grant = access.get(connection.id)!;
    expect(grant.groupIds).toEqual(["g-eng", "g-staff"]);
    expect(grant.reasons).toEqual(
      new Map([
        ["g-staff", new Set(["profile"])],
        ["g-eng", new Set(["team"])],
      ]),
    );
    expect(await managedGroupIds(connection.id)).toEqual(new Set(["g-staff", "g-eng"]));
  });

  it("team groups need an account from the profile", async () => {
    const { person, profile } = await standardSetup();
    await deleteGrants(profile.id);
    expect(await desiredAccess({ ...person, status: "active" })).toEqual(new Map());
  });

  it("people without access should have nothing", async () => {
    const { person } = await standardSetup();
    for (const status of ["planned", "offboarding", "offboarded"] as const) {
      expect(await snapshot({ ...person, status })).toEqual({});
    }
  });

  it("onboarding creates the account with groups", async () => {
    const { person, connection } = await standardSetup();
    const workflow = await startWorkflow(person.id, "onboarding");
    expect((await getPerson(person.id)).status).toBe("onboarding");
    expect(workflow.desired[String(connection.id)]!.groups).toEqual(["g-eng", "g-staff"]);
    await runAll();
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("active");
    const account = one(
      await db()
        .select()
        .from(accounts)
        .where(and(eq(accounts.personId, person.id), eq(accounts.connectionId, connection.id))),
    );
    expect(account.status === "active" && account.createdByApp).toBe(true);
    expect([...STORE.accounts.get(account.externalId)!.groups].sort()).toEqual(["g-eng", "g-staff"]);
    expect(account.observedGroups).toEqual(["g-eng", "g-staff"]);
  });

  it("archiving rechecks status after a workflow finishes", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    const stale = await getPerson(person.id);
    await startWorkflow(person.id, "onboarding");
    await runAll();

    expect(stale.status).toBe("planned");
    await expectRaises(
      archivePerson(stale.id, { actor: approver }),
      LifecycleError,
      /Only planned or offboarded/,
    );
    expect((await getPerson(person.id)).status).toBe("active");
    expect(await auditOf("person.archived")).toEqual([]);
  });

  it("onboarding needs an access profile", async () => {
    const { person } = await standardSetup();
    await setPerson(person.id, { accessProfileId: null });
    await expectRaises(startWorkflow(person.id, "onboarding"), LifecycleError, /access profile/);
  });

  it("access update removes only managed groups", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const account = await accountOf(person.id);
    STORE.accounts.get(account.externalId)!.groups.add("unmanaged");
    await setPerson(person.id, { teamId: null });
    await startWorkflow(person.id, "access_update");
    await runAll();
    expect(STORE.accounts.get(account.externalId)!.groups).toEqual(new Set(["g-staff", "unmanaged"]));
  });

  it("offboarding disables and removes managed groups", async () => {
    const { person } = await standardSetup();
    const user = await makeUser("viewer", "ada@example.invalid", { personId: person.id });
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const workflow = await startWorkflow(person.id, "offboarding");
    expect((await getUser(user.id)).isActive, "offboarding turns off app access at once").toBe(false);
    await runAll();
    const account = await accountOf(person.id);
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("offboarded");
    expect(account.status).toBe("disabled");
    expect(STORE.accounts.get(account.externalId)).toEqual({
      username: "ada",
      email: "ada@example.invalid",
      active: false,
      groups: new Set(),
    });
  });

  it("offboarding reaches profile connections without known accounts", async () => {
    const { person } = await standardSetup();
    await setPerson(person.id, { status: "active" });
    const workflow = await startWorkflow(person.id, "offboarding");
    expect((await jobOf(workflow.id)).action).toBe("disable_account");
  });

  it("offboarding checks an account a comparison missed", async () => {
    const { person, connection, profile } = await standardSetup();
    // An account the profile does not grant, linked by a comparison. A later
    // listing missed it (a page that shifted, an empty answer): it still exists.
    STORE.accounts.set("x1", {
      username: "ada",
      email: "ada@example.invalid",
      active: true,
      groups: new Set(),
    });
    await deleteGrants(profile.id);
    await db()
      .insert(accounts)
      .values({ connectionId: connection.id, personId: person.id, externalId: "x1", status: "missing" });
    await setPerson(person.id, { status: "active" });
    const workflow = await startWorkflow(person.id, "offboarding");
    expect((await jobOf(workflow.id)).action).toBe("disable_account");
    await runAll();
    expect(STORE.accounts.get("x1")!.active).toBe(false);
    // An access update leaves accounts last seen missing to the comparison.
    await db().update(accounts).set({ status: "missing" }).where(eq(accounts.personId, person.id));
    await setPerson(person.id, { status: "active" });
    expect(await jobsOf((await startWorkflow(person.id, "access_update")).id)).toEqual([]);
  });

  it("new workflow replaces the open one", async () => {
    const { person } = await standardSetup();
    const first = await startWorkflow(person.id, "onboarding");
    const second = await startWorkflow(person.id, "offboarding");
    expect((await getWorkflow(first.id)).status).toBe("cancelled");
    expect((await jobOf(first.id)).status).toBe("cancelled");
    expect(isOpen(second.status)).toBe(true);
  });

  it("transient errors retry with backoff", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    STORE.failWith = new TransientError("Fake app answered 503.");
    const claimed = (await claimNextJob())!;
    await runJob(claimed);
    const job = await getJob(claimed.id);
    expect(job.status).toBe("queued");
    expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(job.lastError).toBe("Fake app answered 503.");
    expect(await allTasks()).toEqual([]);
  });

  it("last retry hands the job to a person", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    STORE.failWith = new TransientError("timeout");
    const queued = await onlyJob();
    await setJob(queued.id, { attempts: MAX_ATTEMPTS - 1 });
    await runJob((await claimNextJob())!);
    const job = await getJob(queued.id);
    expect(job.status).toBe("failed");
    const task = one(await tasksWhere({ jobId: job.id }));
    expect(task.kind === "failure" && task.instructions.includes("timeout")).toBe(true);
    expect((await getWorkflow(job.workflowId)).status).toBe("failed");
  });

  it("permanent errors fail at once and retry recovers", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await startWorkflow(person.id, "onboarding");
    STORE.failWith = new AdapterError("Fake app answered 400.");
    await runJob((await claimNextJob())!);
    let job = await onlyJob();
    expect(job.status).toBe("failed");
    STORE.failWith = null;
    await retryJob(job.id, { actor: approver });
    await runAll();
    job = await getJob(job.id);
    expect(job.status).toBe("succeeded");
    expect(one(await tasksWhere({ jobId: job.id })).status).toBe("cancelled");
    expect((await getWorkflow(job.workflowId)).status).toBe("completed");
  });

  it("unexpected errors do not leak details", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    // Python's RuntimeError: an error that is no AdapterError.
    STORE.failWith = new Error("token=supersecret");
    await runJob((await claimNextJob())!);
    const job = await onlyJob();
    expect(job.status).toBe("failed");
    expect(job.lastError).not.toContain("supersecret");
    expect(one(await allTasks()).instructions).not.toContain("supersecret");
  });

  it("manual connections create tasks and completion records the change", async () => {
    const { person, connection } = await standardSetup();
    const approver = await makeUser("approver");
    await setConnection(connection.id, { mode: "manual" });
    const workflow = await startWorkflow(person.id, "onboarding");
    let job = await jobOf(workflow.id);
    expect(job.status).toBe("manual");
    const task = one(await tasksWhere({ jobId: job.id, kind: "change" }));
    expect(task.instructions.includes("Engineering") && task.instructions.includes("Staff")).toBe(true);
    expect((await getWorkflow(workflow.id)).status).toBe("waiting");
    await completeTask(task.id, { actor: approver, note: "Invited" });
    job = await getJob(job.id);
    expect(job.status === "succeeded" && Boolean(job.result.manual)).toBe(true);
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("active");
    expect((await accountOf(person.id)).status).toBe("active");
  });

  it("cancelling a manual task drops the change", async () => {
    const { person, connection } = await standardSetup();
    const approver = await makeUser("approver");
    await setConnection(connection.id, { mode: "manual" });
    const workflow = await startWorkflow(person.id, "onboarding");
    let task = one(await tasksWhere({ jobId: (await jobOf(workflow.id)).id, kind: "change" }));
    await cancelTask(task.id, { actor: approver, note: "Not needed" });
    task = await getTask(task.id);
    expect(task.status === "cancelled" && task.completedById === approver.id).toBe(true);
    expect((await jobOf(workflow.id)).status).toBe("cancelled");
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect(await db().select().from(accounts).where(eq(accounts.personId, person.id))).toEqual([]);
    await expectRaises(cancelTask(task.id, { actor: approver }), ActionError);
  });

  it("disabled connections never change silently", async () => {
    const { person, connection } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    await setConnection(connection.id, { mode: "read_only" });
    const workflow = await startWorkflow(person.id, "offboarding");
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("manual");
    expect(one(await tasksWhere({ jobId: job.id })).instructions).toContain("read only");
    expect(allActive()).toBe(true);
  });

  it("automatic removals over the limit wait for approval", async () => {
    const { person } = await standardSetup();
    const admin = await makeUser("admin");
    await setRemovalLimit(0);
    await startWorkflow(person.id, "onboarding");
    await runAll();
    await setPerson(person.id, { endDate: addDays(today(), -1) });
    const workflow = await startWorkflow(person.id, "offboarding", { automatic: true });
    let job = await jobOf(workflow.id);
    expect(job.status).toBe("held");
    expect(await claimNextJob()).toBeNull();
    await approveJob(job.id, { actor: admin });
    await runAll();
    job = await getJob(job.id);
    expect(job.status).toBe("succeeded");
  });

  it("rejecting a held removal keeps the account", async () => {
    const { person } = await standardSetup();
    const admin = await makeUser("admin");
    await setRemovalLimit(0);
    await startWorkflow(person.id, "onboarding");
    await runAll();
    await setPerson(person.id, { endDate: addDays(today(), -1) });
    let job = await jobOf((await startWorkflow(person.id, "offboarding", { automatic: true })).id);
    await rejectJob(job.id, { actor: admin });
    job = await getJob(job.id);
    expect(job.status).toBe("cancelled");
    expect(allActive()).toBe(true);
    await expectRaises(approveJob(job.id, { actor: admin }), ActionError);
  });

  it("operator removals are never held", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await setRemovalLimit(0);
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await jobOf((await startWorkflow(person.id, "offboarding", { actor: approver })).id);
    expect(job.status).toBe("queued");
  });

  it("stale running jobs go back to the queue", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const job = (await claimNextJob())!;
    await setJob(job.id, { lockedUntil: aSecondAgo() });
    expect(await recoverStaleJobs()).toBe(1);
    expect((await getJob(job.id)).status).toBe("queued");
  });

  it("initial password is emailed never stored", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((to, _subject, body) => [to, body] as const);
    await startWorkflow(person.id, "onboarding");
    await runAll();
    expect(sent.length > 0 && sent[0]![0]).toEqual(["ada@personal.example.invalid"]);
    expect(sent[0]![1]).toContain("Initial-Pass-123");
    const job = await onlyJob();
    expect(job.result.password_generated).toBe(true);
    const stored = (await db().select({ result: jobs.result, lastError: jobs.lastError }).from(jobs)).map(
      (row) => JSON.stringify([row.result, row.lastError]),
    );
    const events = await db().select().from(auditEvents);
    stored.push(...events.map((event) => event.summary));
    stored.push(...events.map((event) => JSON.stringify(event.details)));
    expect(stored.some((value) => value.includes("Initial-Pass-123"))).toBe(false);
    // The audit log shows where it went, without keeping the private address.
    const summary = one(await auditOf("credentials.sent")).summary;
    expect(summary.includes("a***@personal.example.invalid") && !summary.includes("ada@")).toBe(true);
  });

  /**
   * Run the job until the app changed the account, and stop the worker
   * there, before it records anything: a deploy, a crash, a lost database.
   */
  async function stopTheWorkerAfterTheChange(job: Job) {
    expect((await attempt(job)).type).toBe("changed");
    await setJob(job.id, { lockedUntil: aSecondAgo() });
    expect(await recoverStaleJobs()).toBe(1);
  }

  it("sign in details lost with a stopped worker become a task", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((to) => to);
    await startWorkflow(person.id, "onboarding");
    await stopTheWorkerAfterTheChange((await claimNextJob())!);
    await runAll();
    const job = await onlyJob();
    expect(job.status).toBe("succeeded");
    expect(STORE.calls.filter((call) => call.startsWith("create"))).toEqual(["create:ada"]);
    expect(sent, "the password died with the worker").toEqual([]);
    const task = one(await tasksWhere({ kind: "credentials" }));
    expect(task.instructions).toContain("may never have reached them");
    expect(task.instructions).not.toContain("Initial-Pass-123");
  });

  it("a worker that stopped before the change hands over sign in as usual", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((to) => to);
    await startWorkflow(person.id, "onboarding");
    const job = (await claimNextJob())!;
    await setJob(job.id, { lockedUntil: aSecondAgo() });
    await recoverStaleJobs();
    await runAll();
    expect(sent).toEqual([["ada@personal.example.invalid"]]);
    expect(await allTasks()).toEqual([]);
  });

  it("apps without sign in details get no task after a stopped worker", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await stopTheWorkerAfterTheChange((await claimNextJob())!);
    await runAll();
    expect((await onlyJob()).status).toBe("succeeded");
    expect(await allTasks()).toEqual([]);
  });

  it("approvers cannot offboard an admin of this app", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    const admin = await makeUser("admin");
    // Offboarding turns the app user off: an approver could lock every admin out.
    await db().update(users).set({ personId: person.id }).where(eq(users.id, admin.id));
    await setPerson(person.id, { status: "active" });
    await expectRaises(
      startWorkflow(person.id, "offboarding", { actor: approver }),
      LifecycleError,
      /is an admin of this app/,
    );
    expect((await getUser(admin.id)).isActive && (await getPerson(person.id)).status === "active").toBe(true);
    // Another admin may, and so may the schedule after the end date.
    await startWorkflow(person.id, "offboarding", { actor: admin });
    expect((await getUser(admin.id)).isActive).toBe(false);
  });

  it.each([null, 0, 7])(
    "automatic offboarding rechecks the current end date (new end date %s)",
    async (newEndDate) => {
      const { person } = await standardSetup();
      const admin = await makeUser("admin");
      const day = today();
      await setPerson(person.id, { status: "active", endDate: addDays(day, -1) });
      await db().update(users).set({ personId: person.id }).where(eq(users.id, admin.id));

      await setPerson(person.id, { endDate: newEndDate === null ? null : addDays(day, newEndDate) });
      await expectRaises(
        startWorkflow(person.id, "offboarding", { automatic: true }),
        LifecycleError,
        /end date has not passed/,
      );
      expect(await db().select().from(workflows)).toEqual([]);
      expect((await getUser(admin.id)).isActive).toBe(true);
    },
  );

  it("undeliverable password becomes a task", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const task = one(await tasksWhere({ kind: "credentials" }));
    expect(task.instructions).not.toContain("Initial-Pass-123");
  });

  it("account linked to someone else is a conflict", async () => {
    const { person, profile } = await standardSetup();
    const other = await makePerson({
      lastName: "Other",
      workEmail: null,
      personalEmail: "",
      accessProfileId: profile.id,
    });
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const externalId = (await accountOf(person.id)).externalId;
    await db().update(accounts).set({ personId: other.id }).where(eq(accounts.personId, person.id));
    const workflow = await startWorkflow(person.id, "access_update");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("belongs to");
    expect(one(await db().select().from(accounts).where(eq(accounts.externalId, externalId))).personId).toBe(
      other.id,
    );
  });

  it("cancel onboarding returns to planned but offboarding cannot be cancelled", async () => {
    const { person } = await standardSetup();
    const admin = await makeUser("admin");
    const workflow = await startWorkflow(person.id, "onboarding");
    await cancelWorkflow(workflow.id, { actor: admin });
    expect((await getPerson(person.id)).status).toBe("planned");
    const offboarding = await startWorkflow(person.id, "offboarding");
    await expectRaises(cancelWorkflow(offboarding.id, { actor: admin }), LifecycleError);
  });

  it("status rules", async () => {
    const { person } = await standardSetup();
    await expectRaises(startWorkflow(person.id, "access_update"), LifecycleError);
    await startWorkflow(person.id, "onboarding");
    // An onboarding restarts only through an access update.
    await expectRaises(startWorkflow(person.id, "onboarding"), LifecycleError);
  });

  it("offboarding reaches turned off connections as tasks", async () => {
    const { person, connection } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    await setConnection(connection.id, { enabled: false });
    const workflow = await startWorkflow(person.id, "offboarding");
    const job = await jobOf(workflow.id);
    expect(job.action === "disable_account" && job.status === "manual").toBe(true);
    expect(one(await tasksWhere({ jobId: job.id })).instructions).toContain("turned off");
    expect(allActive()).toBe(true);
  });

  it("access updates skip turned off connections", async () => {
    const { person, connection } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    await setConnection(connection.id, { enabled: false });
    const workflow = await startWorkflow(person.id, "access_update");
    expect(await jobsOf(workflow.id)).toEqual([]);
  });

  it("manual tasks name the groups to remove", async () => {
    const { person, connection, groups } = await standardSetup();
    await setConnection(connection.id, { mode: "manual" });
    // Another team makes Operations a managed group that Ada should not have.
    await makeTeam([groups["g-ops"]!], "Ops");
    await startWorkflow(person.id, "onboarding");
    const task = one(await tasksWhere({ kind: "change" }));
    expect(task.instructions).toContain("Remove from these, if a member: Operations.");
  });

  it("a replaced running job never runs again", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const old = (await claimNextJob())!;
    const offboarding = await startWorkflow(person.id, "offboarding");
    const fresh = await jobOf(offboarding.id);
    expect(await claimNextJob(), "waits while the old job for the same app runs").toBeNull();
    STORE.failWith = new TransientError("timeout");
    await runJob(old);
    expect((await getJob(old.id)).status).toBe("cancelled");
    STORE.failWith = null;
    await runAll();
    expect((await getJob(fresh.id)).status).toBe("succeeded");
    expect(await claimNextJob()).toBeNull();
  });

  it("someone elses account is never changed", async () => {
    const { person, profile } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const namesake = await makePerson({
      lastName: "Namesake",
      username: "ada",
      workEmail: null,
      personalEmail: "",
      accessProfileId: profile.id,
      status: "active",
    });
    let job = await jobOf((await startWorkflow(namesake.id, "offboarding")).id);
    await runAll();
    job = await getJob(job.id);
    expect(job.status === "failed" && job.lastError.includes("belongs to Ada Lovelace")).toBe(true);
    expect(allActive()).toBe(true);
    expect(STORE.calls.join(" ")).not.toContain("active:");
  });

  it("initial password survives a failed group step", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((_to, _subject, body) => body);
    STORE.failGroupWith = new TransientError("Fake app answered 503.");
    await startWorkflow(person.id, "onboarding");
    await runAll();
    let job = await onlyJob();
    expect(job.status === "queued" && sent.length === 1).toBe(true);
    expect(sent[0]).toContain("Initial-Pass-123");
    await setJob(job.id, { nextAttemptAt: new Date() });
    await runAll();
    job = await getJob(job.id);
    expect(job.status === "succeeded" && sent.length === 1).toBe(true);
  });

  const GROUPS_UNREADABLE = "Fake app answered 404 while trying to list the user's groups.";

  it("a failing group never blocks offboarding", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    STORE.failGroupReadWith = new AdapterError(GROUPS_UNREADABLE);
    const workflow = await startWorkflow(person.id, "offboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    const account = await accountOf(person.id);
    expect(STORE.accounts.get(account.externalId)!.active).toBe(false);
    expect(job.status).toBe("succeeded");
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("offboarded");
    expect(account.status).toBe("disabled");
    expect(account.appliedGroups, "still the app's to remove").toEqual(["g-eng", "g-staff"]);
    expect(job.result.group_error).toBe(GROUPS_UNREADABLE);
    const task = one(await tasksWhere({ jobId: job.id, status: "open" }));
    expect(task.kind).toBe("failure");
    expect(task.instructions).toContain(GROUPS_UNREADABLE);
    expect(task.instructions).toContain("Engineering, Staff");
  });

  it("a failing group never blocks onboarding", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((_to, _subject, body) => body);
    STORE.failGroupReadWith = new AdapterError(GROUPS_UNREADABLE);
    const workflow = await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    const account = await accountOf(person.id);
    expect(sent.filter((body) => body.includes("Initial-Pass-123"))).toEqual(sent.slice(0, 1));
    expect(job.status).toBe("succeeded");
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("active");
    expect(account.status).toBe("active");
    expect(account.observedGroups, "groups the app could not read are not claimed").toBeNull();
    const task = one(await tasksWhere({ jobId: job.id, status: "open" }));
    expect(task.kind === "failure" && task.instructions.includes(GROUPS_UNREADABLE)).toBe(true);
    expect(task.instructions).toContain("Engineering, Staff");
  });

  it("a newer workflow replaces an unfinished group task", async () => {
    const { person } = await standardSetup();
    STORE.failGroupReadWith = new AdapterError(GROUPS_UNREADABLE);
    await startWorkflow(person.id, "onboarding");
    await runAll();
    let task = one(await tasksWhere({ kind: "failure", status: "open" }));
    STORE.failGroupReadWith = null;
    const workflow = await startWorkflow(person.id, "offboarding");
    await runAll();
    task = await getTask(task.id);
    expect(task.status, "never add an offboarded person to groups").toBe("cancelled");
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect(await tasksWhere({ status: "open" })).toEqual([]);
  });

  it("a replaced running job opens no group task", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const running = (await claimNextJob())!;
    const offboarding = await startWorkflow(person.id, "offboarding");
    STORE.failGroupReadWith = new AdapterError(GROUPS_UNREADABLE);
    await runJob(running);
    STORE.failGroupReadWith = null;
    await runAll();
    expect((await getWorkflow(offboarding.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("offboarded");
    expect(await tasksWhere({ status: "open" })).toEqual([]);
  });

  it("passing group errors retry before they become a task", async () => {
    const { person } = await standardSetup();
    STORE.failGroupReadWith = new TransientError("Fake app answered 503.");
    const workflow = await startWorkflow(person.id, "onboarding");
    await runAll();
    let job = await jobOf(workflow.id);
    expect(job.status === "queued" && job.lastError === "Fake app answered 503.").toBe(true);
    expect(await allTasks()).toEqual([]);
    let account = await accountOf(person.id);
    expect(account.status === "active" && account.createdByApp).toBe(true);
    expect(one(await auditOf("job.ensure_account")).summary.startsWith("Created")).toBe(true);
    await setJob(job.id, { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date() });
    await runAll();
    job = await getJob(job.id);
    account = await accountOf(person.id);
    expect(STORE.accounts.size).toBe(1);
    expect(account.createdByApp).toBe(true);
    expect(job.status).toBe("succeeded");
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect(one(await tasksWhere({ jobId: job.id })).kind).toBe("failure");
  });

  it("an account disabled before a group retry is audited", async () => {
    const { person, profile } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    STORE.failGroupReadWith = new TransientError("Fake app answered 503.");
    let job = await jobOf((await startWorkflow(person.id, "offboarding")).id);
    await runAll();
    job = await getJob(job.id);
    let account = await accountOf(person.id);
    expect(job.status).toBe("queued");
    expect(STORE.accounts.get(account.externalId)!.active).toBe(false);
    const event = one(await auditOf("job.disable_account"));
    expect(event.summary.startsWith("Disabled the Fake app account")).toBe(true);
    expect(event.details.group_error).toBe("Fake app answered 503.");
    // A newer offboarding without the app replaces the retry, and still
    // removes the groups.
    STORE.failGroupReadWith = null;
    await deleteGrants(profile.id);
    const workflow = await startWorkflow(person.id, "offboarding");
    await runAll();
    account = await accountOf(person.id);
    expect((await jobOf(workflow.id)).status).toBe("succeeded");
    expect(account.status).toBe("disabled");
    expect(account.appliedGroups).toEqual([]);
    expect(STORE.accounts.get(account.externalId)!.groups).toEqual(new Set());
  });

  it("a group task stays open where no newer job runs", async () => {
    const { person, profile } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    STORE.failGroupReadWith = new AdapterError(GROUPS_UNREADABLE);
    await startWorkflow(person.id, "offboarding");
    await runAll();
    STORE.failGroupReadWith = null;
    let task = one(await tasksWhere({ kind: "failure", status: "open" }));
    // Hired again with a profile that no longer has this app.
    await deleteGrants(profile.id);
    const rehire = await startWorkflow(person.id, "onboarding");
    await runAll();
    task = await getTask(task.id);
    expect(await jobsOf(rehire.id)).toEqual([]);
    expect(task.status, "nothing else removes the groups").toBe("open");
  });

  it("unexpected group errors do not leak details", async () => {
    const { person } = await standardSetup();
    STORE.failGroupReadWith = new Error("token=supersecret");
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await onlyJob();
    expect(job.status).toBe("succeeded");
    expect(JSON.stringify(job.result)).not.toContain("supersecret");
    expect(one(await tasksWhere({ jobId: job.id })).instructions).not.toContain("supersecret");
  });

  it("groups dropped from the policy are removed", async () => {
    const { person, profile } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    let account = await accountOf(person.id);
    expect(account.appliedGroups).toEqual(["g-eng", "g-staff"]);
    STORE.accounts.get(account.externalId)!.groups.add("unmanaged");
    await clearGrantGroups(profile.id);
    await startWorkflow(person.id, "access_update");
    await runAll();
    expect(STORE.accounts.get(account.externalId)!.groups).toEqual(new Set(["g-eng", "unmanaged"]));
    account = await accountOf(person.id);
    expect(account.appliedGroups).toEqual(["g-eng"]);
  });

  it("groups applied by a still running job are removed later", async () => {
    const { person, profile } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const running = (await claimNextJob())!;
    await clearGrantGroups(profile.id);
    let replacement = await jobOf((await startWorkflow(person.id, "access_update")).id);
    expect(replacement.managedGroups).not.toContain("g-staff");
    await runJob(running);
    await runAll();
    replacement = await getJob(replacement.id);
    expect(replacement.status).toBe("succeeded");
    const account = await accountOf(person.id);
    expect(STORE.accounts.get(account.externalId)!.groups).toEqual(new Set(["g-eng"]));
    expect(account.appliedGroups).toEqual(["g-eng"]);
  });

  it("applying access during onboarding still ends active", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const workflow = await startWorkflow(person.id, "access_update");
    expect(workflow.kind).toBe("onboarding");
    await runAll();
    expect((await getPerson(person.id)).status).toBe("active");
  });

  it("cancelling a workflow keeps the result of its running job", async () => {
    const { person } = await standardSetup();
    const admin = await makeUser("admin");
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((_to, _subject, body) => body);
    const workflow = await startWorkflow(person.id, "onboarding");
    const claimed = (await claimNextJob())!;
    await cancelWorkflow(workflow.id, { actor: admin });
    await runJob(claimed);
    const job = await getJob(claimed.id);
    expect(job.status).toBe("succeeded");
    expect((await getWorkflow(workflow.id)).status).toBe("cancelled");
    expect((await accountOf(person.id)).status).toBe("active");
    expect(sent.length === 1 && sent[0]!.includes("Initial-Pass-123")).toBe(true);
    expect(one(await auditOf("job.ensure_account")).summary).toBe(
      "Created the Fake app account of Ada Lovelace. Its workflow was cancelled or " +
        "replaced while it ran, too late to stop the change.",
    );
  });

  it("a job cancelled while it ran still records its change", async () => {
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent = captureEmails((_to, _subject, body) => body);
    await startWorkflow(person.id, "onboarding");
    const claimed = (await claimNextJob())!;
    await cancelJob((await loadJob(claimed.id))!, { note: "Cancelled elsewhere." });
    await runJob(claimed);
    expect((await accountOf(person.id)).status).toBe("active");
    expect(sent.length === 1 && sent[0]!.includes("Initial-Pass-123")).toBe(true);
    // The change was made: the job is not shown as cancelled.
    expect((await getJob(claimed.id)).status).toBe("succeeded");
    expect(one(await auditOf("job.ensure_account")).summary).toBe(
      "Created the Fake app account of Ada Lovelace. It was cancelled while it ran, " +
        "too late to stop the change.",
    );
  });

  it("a worker that was only slow makes a cancel too late", async () => {
    // The lease ran out while the worker still talked to the connection, and
    // a newer workflow replaced the job's: the stale job was cancelled, but
    // the change was made.
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const slow = (await claimNextJob())!;
    const attempted = await attempt(slow);
    await setJob(slow.id, { lockedUntil: aSecondAgo() });
    await startWorkflow(person.id, "access_update"); // restarts the onboarding
    expect(await recoverStaleJobs()).toBe(1);
    expect((await getJob(slow.id)).status).toBe("cancelled");
    await finish(slow, attempted);
    const job = await getJob(slow.id);
    expect(job.status).toBe("succeeded");
    expect(job.result.created).toBe(true);
    expect(one(await auditOf("job.ensure_account", job.id)).summary).toContain(
      "It was cancelled while it ran, too late to stop the change.",
    );
  });

  const TOO_LATE_FOR_THE_ACCOUNT =
    "Create or update account at Fake app for Ada Lovelace: an earlier run already did " +
    "the account step, so the cancel stopped only the groups. They are left as they are.";

  describe.each(["created", "found active"] as const)(
    "a cancel while the groups wait (account %s)",
    (account) => {
      it.each(["cancelled", "replaced"] as const)("comes too late for the account (%s)", async (how) => {
        // The account step is done (an account created, or one found active);
        // only the groups wait for another try. The job is done: the cancel
        // stops only the groups.
        const { person } = await standardSetup();
        const approver = await makeUser("approver");
        if (account === "created") {
          STORE.failGroupWith = new TransientError("Fake app answered 503.");
        } else {
          STORE.accounts.set("u-ada", {
            username: "ada",
            email: "ada@example.invalid",
            active: true,
            groups: new Set(),
          });
          STORE.failGroupReadWith = new TransientError("Fake app answered 503.");
        }
        const workflow = await startWorkflow(person.id, "onboarding", { actor: approver });
        await runAll();
        let job = await jobOf(workflow.id);
        expect(job.status).toBe("queued");
        if (how === "cancelled") await cancelWorkflow(workflow.id, { actor: approver });
        else await startWorkflow(person.id, "access_update", { actor: approver });
        job = await getJob(job.id);
        expect(job.status).toBe("succeeded");
        expect([job.result.account, job.result.created]).toEqual(["ada", account === "created"]);
        expect((await accountOf(person.id)).status).toBe("active");
        const events = await auditOf("job.ensure_account", job.id);
        expect(events.at(-1)!.summary).toBe(TOO_LATE_FOR_THE_ACCOUNT);
        expect(await tasksWhere({ jobId: job.id, status: "open" })).toEqual([]);
      });
    },
  );

  it("a retry that fails after a replace keeps the account step", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    STORE.failGroupWith = new TransientError("Fake app answered 503.");
    await startWorkflow(person.id, "onboarding", { actor: approver });
    await runAll();
    await db().update(jobs).set({ nextAttemptAt: new Date() });
    const retry = (await claimNextJob())!;
    STORE.failWith = new AdapterError("Fake app answered 400.");
    const attempted = await attempt(retry);
    await startWorkflow(person.id, "access_update", { actor: approver });
    await finish(retry, attempted);
    const job = await getJob(retry.id);
    expect(job.status).toBe("succeeded");
    const events = await auditOf("job.ensure_account", job.id);
    expect(events.at(-1)!.summary).toBe(TOO_LATE_FOR_THE_ACCOUNT);
  });

  it("job locks never cover joined rows", async () => {
    const { person } = await standardSetup();
    const admin = await makeUser("admin");
    const workflow = await startWorkflow(person.id, "onboarding");
    const queries = await captureQueries(async () => {
      await claimNextJob();
      await startWorkflow(person.id, "access_update"); // restarts the onboarding
      const [latest] = await db().select().from(workflows).orderBy(desc(workflows.id)).limit(1);
      await cancelWorkflow(latest!.id, { actor: admin });
    });
    const locking = queries.filter((sql) => / for update/i.test(sql) && / join /i.test(sql));
    expect(locking.length, `locking joins (workflow ${workflow.id})`).toBeGreaterThan(0);
    for (const sql of locking) expect(sql).toMatch(/ for update of "iam_job"/i);
  });

  it("a job changes the account it checked", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    expect(STORE.calls.filter((call) => call === "find")).toHaveLength(1);
  });

  it("jobs that finish at once still complete the workflow", async () => {
    const { person, profile } = await standardSetup();
    const second = await makeConnection({ name: "Second app" });
    await grant(profile, second);
    const workflow = await startWorkflow(person.id, "onboarding");
    const both = await jobsOf(workflow.id);
    await db().update(jobs).set({ status: "running" }).where(eq(jobs.workflowId, workflow.id));
    // Both transactions have saved their job before either works out the
    // workflow (threading.Barrier(2, timeout=5)).
    let arrived = 0;
    let broken = false;
    let release!: () => void;
    const allArrived = new Promise<void>((resolve) => (release = resolve));
    const barrierWait = async () => {
      // The lock already makes the second transaction wait.
      if (broken) return;
      arrived += 1;
      if (arrived === 2) return release();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        allArrived,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            broken = true;
            resolve();
          }, 5_000);
        }),
      ]);
      clearTimeout(timer);
    };
    const original = seams.refreshWorkflow;
    seams.refreshWorkflow = async (workflowId) => {
      await barrierWait();
      return original(workflowId);
    };
    try {
      await Promise.all(
        both.map(async (job) => {
          const account = externalAccount(`x${job.id}`, { username: `x${job.id}` });
          await finish((await loadJob(job.id))!, { type: "changed", result: ensureResult(account) });
        }),
      );
    } finally {
      seams.refreshWorkflow = original;
    }
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("active");
  });

  it("the schedule completes workflows left open", async () => {
    const { person } = await standardSetup();
    const workflow = await startWorkflow(person.id, "onboarding");
    await runAll();
    // As two job changes that committed side by side used to leave it.
    await db().update(workflows).set({ status: "running" }).where(eq(workflows.id, workflow.id));
    await setPerson(person.id, { status: "onboarding" });
    expect((await runSchedule()).settled).toBe(1);
    expect((await getWorkflow(workflow.id)).status).toBe("completed");
    expect((await getPerson(person.id)).status).toBe("active");
  });

  it("a worker whose lease ran out leaves the new claim alone", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const first = (await claimNextJob())!;
    await setJob(first.id, { lockedUntil: aSecondAgo() });
    await recoverStaleJobs();
    const second = (await claimNextJob())!;
    expect(second.id).toBe(first.id);
    // The first worker comes back: its failure must not requeue the second claim.
    STORE.failWith = new TransientError("Fake app answered 503.");
    await runJob(first);
    let job = await getJob(first.id);
    expect(job.status).toBe("running");
    expect(job.lockedUntil).toEqual(second.lockedUntil);
    // Its success records the account, but the second claim settles the job.
    STORE.failWith = null;
    await runJob(first);
    job = await getJob(first.id);
    expect(job.status).toBe("running");
    expect((await accountOf(person.id)).status).toBe("active");
    await runJob(second);
    job = await getJob(first.id);
    expect(job.status).toBe("succeeded");
  });

  it("a replaced job at a turned off connection opens no task", async () => {
    const { person, connection } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const claimed = (await claimNextJob())!;
    await startWorkflow(person.id, "offboarding");
    await setConnection(connection.id, { enabled: false });
    await runJob(claimed);
    expect((await getJob(claimed.id)).status).toBe("cancelled");
    expect(await tasksWhere({ jobId: claimed.id })).toEqual([]);
  });

  it("offboarding waits for an account a replaced job still creates", async () => {
    const { person, profile } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const creating = (await claimNextJob())!;
    await deleteGrants(profile.id);
    const offboarding = await startWorkflow(person.id, "offboarding");
    let removal = await jobOf(offboarding.id);
    expect(removal.action).toBe("disable_account");
    expect(await claimNextJob(), "waits while the replaced job runs").toBeNull();
    await runJob(creating);
    await runAll();
    removal = await getJob(removal.id);
    expect(removal.status).toBe("succeeded");
    expect((await accountOf(person.id)).status).toBe("disabled");
  });

  it("a late worker never undoes what the new claim settled", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    const first = (await claimNextJob())!;
    await setJob(first.id, { lockedUntil: aSecondAgo() });
    await recoverStaleJobs();
    const second = (await claimNextJob())!;
    await runJob(second);
    let job = await getJob(first.id);
    expect(job.status).toBe("succeeded");
    const settled = [job.result, job.finishedAt];
    STORE.failWith = new AdapterError("Fake app answered 400.");
    await runJob(first);
    job = await getJob(first.id);
    expect(job.status === "succeeded" && (await allTasks()).length === 0).toBe(true);
    STORE.failWith = null;
    const audited = (await auditOf("job.ensure_account")).length;
    await runJob(first);
    job = await getJob(first.id);
    expect([job.result, job.finishedAt]).toEqual(settled);
    // The late change is still audited, as every change by the worker.
    expect(await auditOf("job.ensure_account")).toHaveLength(audited + 1);
  });

  it("job changes lock the person first", async () => {
    const { person, connection } = await standardSetup();
    const admin = await makeUser("admin");

    const firstLock = async (action: () => Promise<unknown>) => {
      const queries = await captureQueries(action);
      const locks = queries.filter((sql) => / for /i.test(sql) && /update/i.test(sql));
      return locks.length > 0
        ? locks[0]!
            .split(/ from /i)[1]!
            .trim()
            .split(/\s+/)[0]
        : null;
    };

    await startWorkflow(person.id, "onboarding");
    let job = (await claimNextJob())!;
    const claimed = job;
    expect(
      await firstLock(() =>
        finish(claimed, { type: "failed", message: "Fake app answered 400.", retryable: false }),
      ),
    ).toBe('"iam_person"');
    expect(await firstLock(() => retryJob(claimed.id, { actor: admin }))).toBe('"iam_person"');
    await setConnection(connection.id, { mode: "manual" });
    job = (await claimNextJob())!;
    const manual = job;
    expect(await firstLock(() => runJob(manual))).toBe('"iam_person"');
    const task = one(await tasksWhere({ jobId: job.id, status: "open" }));
    expect(await firstLock(() => completeTask(task.id, { actor: admin }))).toBe('"iam_person"');
  });

  it("groups marked missing are left alone", async () => {
    const { person, groups } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    let account = await accountOf(person.id);
    expect(STORE.accounts.get(account.externalId)!.groups).toEqual(new Set(["g-staff", "g-eng"]));
    // An import that read nothing marked every group missing.
    for (const group of Object.values(groups)) {
      await db().update(providerGroups).set({ missing: true }).where(eq(providerGroups.id, group.id));
    }
    await startWorkflow(person.id, "access_update");
    await runAll();
    expect(STORE.accounts.get(account.externalId)!.groups).toEqual(new Set(["g-staff", "g-eng"]));
    account = await accountOf(person.id);
    expect(account.appliedGroups).toEqual(["g-eng", "g-staff"]);
  });

  it("sign in the adapter could not arrange becomes a task", async () => {
    const { person } = await standardSetup();
    FakeAdapter.credentialsProblem = "The setup email was not sent. Send it by hand.";
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const task = one(await tasksWhere({ kind: "credentials" }));
    expect(task.instructions).toBe("The setup email was not sent. Send it by hand.");
  });

  it("a cancelled onboarding waits for a new start date", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await setPerson(person.id, { startDate: today() });
    const [workflow, ...others] = await startDueOnboarding();
    expect(others).toEqual([]);
    await cancelWorkflow(workflow!.id, { actor: approver });
    let current = await getPerson(person.id);
    expect(current.status === "planned" && current.onboardingPaused).toBe(true);
    expect(await startDueOnboarding()).toEqual([]);
    // Starting it by hand is still possible, and lifts the pause.
    await startWorkflow(person.id, "onboarding", { actor: approver });
    current = await getPerson(person.id);
    expect(current.status === "onboarding" && !current.onboardingPaused).toBe(true);
  });

  it("onboarding refuses an end date that has passed", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await setPerson(person.id, { status: "offboarded", endDate: addDays(today(), -1) });
    await expectRaises(
      startWorkflow(person.id, "onboarding", { actor: approver }),
      LifecycleError,
      /has passed/,
    );
    await setPerson(person.id, { endDate: null });
    expect(await startWorkflow(person.id, "onboarding", { actor: approver })).toBeTruthy();
  });

  it("sign in details survive a newer workflow", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    FakeAdapter.password = "Initial-Pass-123";
    // No email connection: a task hands over the details. A passing group
    // error keeps the job queued, so the newer workflow cancels it.
    STORE.failGroupWith = new TransientError("Fake app answered 503.");
    await startWorkflow(person.id, "onboarding", { actor: approver });
    await runAll();
    let credentials = one(await tasksWhere({ kind: "credentials" }));
    await startWorkflow(person.id, "access_update", { actor: approver });
    await runAll();
    credentials = await getTask(credentials.id);
    expect(credentials.status).toBe("open");
  });

  it("retrying a job keeps its sign in details", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    FakeAdapter.password = "Initial-Pass-123";
    STORE.failGroupWith = new TransientError("Fake app answered 503.");
    await startWorkflow(person.id, "onboarding", { actor: approver });
    await runAll();
    let job = await onlyJob();
    STORE.failWith = new AdapterError("Fake app answered 400.");
    await setJob(job.id, { nextAttemptAt: new Date() });
    await runAll();
    job = await getJob(job.id);
    expect(job.status).toBe("failed");
    await retryJob(job.id, { actor: approver });
    const credentials = one(await tasksWhere({ kind: "credentials" }));
    expect(credentials.status).toBe("open");
  });

  it("cancelling the sign in task keeps the job", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    FakeAdapter.password = "Initial-Pass-123";
    STORE.failGroupWith = new TransientError("Fake app answered 503.");
    await startWorkflow(person.id, "onboarding", { actor: approver });
    await runAll();
    let job = await onlyJob();
    expect(job.status).toBe("queued");
    await cancelTask(one(await tasksWhere({ kind: "credentials" })).id, { actor: approver });
    job = await getJob(job.id);
    expect(job.status).toBe("queued");
  });
});
