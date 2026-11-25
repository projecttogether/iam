import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError, TransientError } from "../adapters/base";
import { overrideConfigForTests } from "../config";
import { getDb } from "../db/client";
import {
  accounts,
  auditEvents,
  connections,
  jobs,
  people,
  tasks,
  workflows,
  type Connection,
  type Job,
  type Person,
} from "../db/schema";
import { atomic, inTransaction, q } from "../db/tx";
import { FakeAdapter, STORE, type FakeStore } from "../test/fake-adapter";
import { standardSetup, useEngineFixtures } from "../test/fixtures";
import {
  attempt,
  cancelJob,
  claimNextJob,
  finish,
  loadJob,
  recoverStaleJobs,
  refreshWorkflow,
  type JobState,
} from "./jobs";
import { startWorkflow } from "./lifecycle";
import type * as EmailModule from "./email";

/**
 * Port of tests/test_job_finish.py: how a claimed job ends. Every outcome of
 * its attempt at the connection, in every situation the job can be in when
 * finish records it.
 *
 * A worker claims a job, makes the change at the connection (attempt), and
 * records the outcome (finish). Meanwhile a newer workflow may replace the
 * job's workflow, another worker may claim the job after this claim's lease
 * ran out, or someone may close the job. Each row pins what the app records
 * then: the job's and the workflow's status, the open tasks, the audit
 * events, the person's account, and whether the sign-in details reached the
 * person.
 *
 * A change the connection made is never shown as cancelled: a cancel that
 * came while it was under way came too late, and the job's history says so.
 */

/** Python: monkeypatch.setattr("iam.jobs.send_email", ...). jobs.ts calls sendEmail of ./email. */
const hooks = vi.hoisted(() => ({
  sendEmail: null as null | ((to: string[], subject: string, body: string) => Promise<boolean>),
}));
vi.mock("./email", async (importOriginal) => {
  const actual = await importOriginal<typeof EmailModule>();
  return {
    ...actual,
    sendEmail: (to: string[], subject: string, body: string) =>
      (hooks.sendEmail ?? actual.sendEmail)(to, subject, body),
  };
});

const SITUATIONS = ["current", "replaced", "claimed elsewhere", "closed meanwhile"] as const;
type Situation = (typeof SITUATIONS)[number];

const SIGNED_IN = ["credentials.sent", "job.ensure_account"];
// The job's history says that the cancel came too late for the change.
const TOO_LATE = ["credentials.sent", "job.ensure_account (too late)"];
const NOTHING: string[] = [];

type Row = [string, string, string[], string[], string | null, number];

// outcome: one row per situation, in the order of SITUATIONS:
// (job status, workflow status, open tasks, job audit events, account, emails)
const EXPECTED: Record<string, Row[]> = {
  // The account was created with its groups.
  changed: [
    ["succeeded", "completed", [], SIGNED_IN, "active", 1],
    ["succeeded", "cancelled", [], TOO_LATE, "active", 1],
    ["running", "running", [], SIGNED_IN, "active", 1],
    ["succeeded", "completed", [], TOO_LATE, "active", 1],
  ],
  // The account was created; a group step failed for good.
  "groups failed": [
    ["succeeded", "completed", ["failure"], SIGNED_IN, "active", 1],
    ["succeeded", "cancelled", [], TOO_LATE, "active", 1],
    ["running", "running", [], SIGNED_IN, "active", 1],
    ["succeeded", "completed", ["failure"], TOO_LATE, "active", 1],
  ],
  // The account was created; a group step failed for now, before the last
  // attempt. A cancelled job does not run again for the groups: a newer
  // workflow does them, or else a person.
  "groups pending": [
    ["queued", "running", [], SIGNED_IN, "active", 1],
    ["succeeded", "cancelled", [], TOO_LATE, "active", 1],
    ["running", "running", [], SIGNED_IN, "active", 1],
    ["succeeded", "completed", ["failure"], TOO_LATE, "active", 1],
  ],
  // The account changed, but by then it was linked to someone else.
  "linked to someone else": [
    ["failed", "failed", ["failure"], ["job.failed"], null, 0],
    ["cancelled", "cancelled", [], NOTHING, null, 0],
    ["running", "running", [], NOTHING, null, 0],
    ["cancelled", "completed", [], NOTHING, null, 0],
  ],
  "failed for now": [
    ["queued", "running", [], NOTHING, null, 0],
    ["cancelled", "cancelled", [], NOTHING, null, 0],
    ["running", "running", [], NOTHING, null, 0],
    ["cancelled", "completed", [], NOTHING, null, 0],
  ],
  failed: [
    ["failed", "failed", ["failure"], ["job.failed"], null, 0],
    ["cancelled", "cancelled", [], NOTHING, null, 0],
    ["running", "running", [], NOTHING, null, 0],
    ["cancelled", "completed", [], NOTHING, null, 0],
  ],
  // The connection stopped changing accounts automatically meanwhile.
  "for a person": [
    ["manual", "waiting", ["change"], NOTHING, null, 0],
    ["cancelled", "cancelled", [], NOTHING, null, 0],
    ["running", "running", [], NOTHING, null, 0],
    ["cancelled", "completed", [], NOTHING, null, 0],
  ],
  rehearsed: [
    ["rehearsed", "completed", [], ["job.rehearsed"], null, 0],
    ["cancelled", "cancelled", [], NOTHING, null, 0],
    ["running", "running", [], NOTHING, null, 0],
    ["cancelled", "completed", [], NOTHING, null, 0],
  ],
};

/**
 * Arranges the attempt's outcome. Returns what happens between the attempt
 * and finish, if anything.
 */
async function arrangeOutcome(
  outcome: string,
  store: FakeStore,
  connection: Connection,
): Promise<(() => Promise<void>) | null> {
  if (outcome === "groups failed") {
    store.failGroupWith = new AdapterError("Fake app answered 400.");
  } else if (outcome === "groups pending") {
    store.failGroupWith = new TransientError("Fake app answered 503.");
  } else if (outcome === "linked to someone else") {
    store.accounts.set("u-ada", {
      username: "ada",
      email: "ada@example.invalid",
      active: true,
      groups: new Set(),
    });
    return async () => {
      // After the attempt checked whose account it changes.
      const [grace] = await getDb()
        .insert(people)
        .values({ firstName: "Grace", lastName: "Hopper" })
        .returning();
      await getDb()
        .insert(accounts)
        .values({ connectionId: connection.id, personId: grace!.id, externalId: "u-ada", username: "ada" });
    };
  } else if (outcome === "failed for now") {
    store.failWith = new TransientError("Fake app answered 503.");
  } else if (outcome === "failed") {
    store.failWith = new AdapterError("Fake app answered 400.");
  } else if (outcome === "for a person") {
    await getDb().update(connections).set({ mode: "manual" }).where(eq(connections.id, connection.id));
  } else if (outcome === "rehearsed") {
    overrideConfigForTests({ READ_ONLY: true });
  }
  return null;
}

async function arrangeSituation(situation: Situation, claim: JobState, person: Person): Promise<void> {
  if (situation === "replaced") {
    // Applying access during onboarding starts a new onboarding.
    await startWorkflow(person.id, "access_update");
  } else if (situation === "claimed elsewhere") {
    await getDb()
      .update(jobs)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, claim.id));
    expect(await recoverStaleJobs()).toBe(1);
    expect((await claimNextJob())?.id).toBe(claim.id);
  } else if (situation === "closed meanwhile") {
    await atomic(async () => {
      await cancelJob((await loadJob(claim.id))!, { note: "Closed meanwhile." });
      await refreshWorkflow(claim.workflowId);
    });
  }
}

/** The job's audit events, marked where one says the cancel came too late. */
async function history(job: Pick<Job, "id">): Promise<string[]> {
  const events = await getDb()
    .select({ action: auditEvents.action, summary: auditEvents.summary })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, "job"), eq(auditEvents.targetId, String(job.id))));
  return events
    .map(({ action, summary }) => (summary.includes("too late") ? `${action} (too late)` : action))
    .sort();
}

async function observe(claim: Pick<Job, "id">, person: Person, sent: string[][]): Promise<Row> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, claim.id));
  const [workflow] = await getDb().select().from(workflows).where(eq(workflows.id, job!.workflowId));
  const open = await getDb()
    .select({ kind: tasks.kind })
    .from(tasks)
    .where(and(eq(tasks.jobId, job!.id), eq(tasks.status, "open")));
  const [account] = await getDb()
    .select({ status: accounts.status })
    .from(accounts)
    .where(eq(accounts.personId, person.id))
    .orderBy(asc(accounts.id))
    .limit(1);
  return [
    job!.status,
    workflow!.status,
    open.map((task) => task.kind).sort(),
    await history(job!),
    account?.status ?? null,
    sent.length,
  ];
}

const CASES = Object.entries(EXPECTED).flatMap(([outcome, rows]) =>
  SITUATIONS.map((situation, index) => ({ outcome, situation, expected: rows[index]! })),
);

describe("how a claimed job ends", () => {
  useEngineFixtures();
  afterEach(() => {
    hooks.sendEmail = null;
  });

  it.each(CASES)("$outcome, $situation", async ({ outcome, situation, expected }) => {
    const { connection, person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    const sent: string[][] = [];
    hooks.sendEmail = async (to) => {
      sent.push(to);
      return true;
    };
    await startWorkflow(person.id, "onboarding");
    const claim = (await claimNextJob())!;
    const meanwhile = await arrangeOutcome(outcome, STORE, connection);
    const attempted = await attempt(claim);
    if (meanwhile !== null) await meanwhile();
    await arrangeSituation(situation, claim, person);
    await finish(claim, attempted);
    expect(await observe(claim, person, sent)).toEqual(expected);
  });

  it("sends the sign-in details after a group retry commits", async () => {
    // When a group step fails for now, the account and the requeue commit
    // together, and only then does the initial password leave the app.
    const { person } = await standardSetup();
    FakeAdapter.password = "Initial-Pass-123";
    STORE.failGroupWith = new TransientError("Fake app answered 503.");
    const seen: [boolean, string, boolean][] = [];
    hooks.sendEmail = async () => {
      const recorded =
        (await q().select({ id: accounts.id }).from(accounts).where(eq(accounts.personId, person.id)))
          .length > 0;
      const [job] = await q().select({ status: jobs.status }).from(jobs);
      seen.push([inTransaction(), job!.status, recorded]);
      return true;
    };
    await startWorkflow(person.id, "onboarding");
    const claim = (await claimNextJob())!;
    await finish(claim, await attempt(claim));
    expect(seen).toEqual([[false, "queued", true]]);
  });
});
