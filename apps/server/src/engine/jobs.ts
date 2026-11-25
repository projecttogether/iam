import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, lte, ne, notInArray, sql } from "drizzle-orm";
import {
  FINISHED_JOB_STATUSES,
  JOB_ACTION_LABELS,
  OPEN_JOB_STATUSES,
  OPEN_WORKFLOW_STATUSES,
  PERSON_STATUS_LABELS,
} from "@iam/shared/labels";
import { config } from "../config";
import { SecretUnreadable } from "../core/crypto";
import {
  AdapterError,
  AdapterKind,
  type AccountSpec,
  type Adapter,
  type DisableResult,
  type EnsureResult,
  type ExternalAccount,
} from "../adapters/base";
import {
  accounts,
  auditEvents,
  connections,
  jobs,
  people,
  providerGroups,
  tasks,
  teams,
  workflows,
  type AuditEvent,
  type Connection,
  type Job,
  type JobStatus,
  type Person,
  type Task,
  type TaskKind,
  type TaskStatus,
  type User,
  type Workflow,
} from "../db/schema";
import { atomic, onCommit, q } from "../db/tx";
import { logger } from "../logger";
import { reportError } from "../error-reporting";
import * as accountsLedger from "./accounts";
import { record } from "./audit";
import { adapterClassOf, buildAdapter, writesAutomatically } from "./connections";
import { maskEmail, notifyTasks, sendEmail } from "./email";
import { fullName, loginName } from "./people";
import { loadSettings } from "./settings";

/**
 * Jobs and their tasks: one account change at one connection.
 *
 * This is the only module that changes the status of a job, a task or a
 * workflow. Lifecycle plans a workflow's jobs and hands them over with
 * startJobs, or stops them with stopWorkflow; the worker claims and runs
 * them; people retry, approve, reject, complete or cancel them. Every change
 * ends the same way: the workflow's status is worked out again from its jobs
 * (refreshWorkflow), which also finishes the person's status, and people
 * hear about new tasks once the change commits.
 *
 * The worker claims queued jobs one at a time and runs each in two steps
 * (runJob): attempt talks to the connection and writes nothing in this app;
 * finish records the outcome, and is the only code that settles a claimed
 * job. A connection that may change accounts gets the adapter call; any
 * other connection gets a manual task. A failure that clears on its own
 * (timeouts, rate limits, server errors) runs again with growing pauses; any
 * other failure, or the last retry, hands the job to a person as a failure
 * task. Groups never hold up an account: once the account is created,
 * reactivated or disabled, a group step that keeps failing becomes a task
 * while the job succeeds. A change the connection made is never shown as
 * cancelled: a cancel that came while the job ran came too late for it, the
 * job succeeds, and its history says so. Nothing here stores passwords: a
 * new account's initial password is emailed once to the personal address
 * and forgotten.
 *
 * In read-only mode (READ_ONLY=1) the worker rehearses every job instead: it
 * reads what the job would change, from the plan the adapter follows when it
 * runs the job, records that in the result, changes nothing and hands
 * nothing to a person, and no email leaves the app.
 */

export const MAX_ATTEMPTS = 6;

/** The pause before the next attempt: 1, 2, 4 ... minutes, at most an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), 60) * 60_000;
}

/** A job with its connection and person, as loaded for a change. */
export type JobState = Job & { connection: Connection; person: Person };

type Actor = Pick<User, "id" | "email"> | null;

const target = (job: Pick<Job, "id">) => ({ type: "job", id: job.id });
const actionLabel = (job: Pick<Job, "action">) => JOB_ACTION_LABELS[job.action];

/** "Create or update account at Keycloak for Ada Lovelace" */
export function jobLabel(job: JobState): string {
  return `${actionLabel(job)} at ${job.connection.name} for ${fullName(job.person)}`;
}

async function loadState(job: Job): Promise<JobState> {
  const [connection] = await q().select().from(connections).where(eq(connections.id, job.connectionId));
  const [person] = await q().select().from(people).where(eq(people.id, job.personId));
  return { ...job, connection: connection!, person: person! };
}

export async function loadJob(id: number): Promise<JobState | null> {
  const [job] = await q().select().from(jobs).where(eq(jobs.id, id));
  return job ? loadState(job) : null;
}

export async function accountSpecOf(person: Person): Promise<AccountSpec> {
  let team = "";
  if (person.teamId !== null) {
    const [row] = await q().select({ name: teams.name }).from(teams).where(eq(teams.id, person.teamId));
    team = row?.name ?? "";
  }
  let managerEmail = "";
  if (person.managerId !== null) {
    const [row] = await q()
      .select({ workEmail: people.workEmail })
      .from(people)
      .where(eq(people.id, person.managerId));
    managerEmail = row?.workEmail ?? "";
  }
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    username: loginName(person),
    email: person.workEmail ?? "",
    personalEmail: person.personalEmail,
    jobTitle: person.jobTitle,
    personType: person.personType,
    team,
    managerEmail,
    startDate: person.startDate,
    endDate: person.endDate,
  };
}

/**
 * The groups the job may remove: the policy's managed groups when it was
 * planned, plus the groups the app has put the account in since.
 */
export function managedGroups(
  job: Pick<Job, "connectionId" | "personId" | "managedGroups">,
): Promise<Set<string>> {
  return accountsLedger.removableGroups(job.connectionId, job.personId, job.managedGroups);
}

async function groupNameMap(connectionId: number, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q()
    .select({ externalId: providerGroups.externalId, name: providerGroups.name })
    .from(providerGroups)
    .where(and(eq(providerGroups.connectionId, connectionId), inArray(providerGroups.externalId, ids)));
  return new Map(rows.map((row) => [row.externalId, row.name]));
}

/** The names of the job's groups, in the job's order. */
export async function groupLabels(job: Pick<Job, "connectionId" | "groups">): Promise<string[]> {
  const names = await groupNameMap(job.connectionId, job.groups);
  return job.groups.map((id) => names.get(id) ?? id);
}

// -- starting and stopping ------------------------------------------------------

/**
 * Takes over the jobs a new workflow planned: cancels the group tasks they
 * replace, and hands jobs at connections without automation to a person.
 * Returns the cancelled group tasks. The caller refreshes the workflow once
 * it has recorded the start.
 */
export async function startJobs(
  personId: number,
  planned: JobState[],
  options: { actor?: Actor } = {},
): Promise<number[]> {
  const cancelled = await cancelReplacedGroupTasks(personId, planned, options.actor ?? null);
  // In read-only mode the worker rehearses these jobs like all others.
  const newTasks: (Task | null)[] = [];
  for (const job of planned) {
    if (job.status === "queued" && !writesAutomatically(job.connection) && !config().READ_ONLY) {
      newTasks.push(await handToPerson(job));
    }
  }
  notifyAfterCommit(newTasks);
  return cancelled;
}

/**
 * Groups an earlier job left unfinished, at the connections the new workflow
 * plans again. Elsewhere the task stays open: nothing else will finish those
 * groups.
 */
async function cancelReplacedGroupTasks(
  personId: number,
  planned: JobState[],
  actor: Actor,
): Promise<number[]> {
  const connectionIds = planned.map((job) => job.connectionId);
  if (connectionIds.length === 0) return [];
  const rows = await q()
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(jobs, eq(jobs.id, tasks.jobId))
    .where(
      and(
        eq(tasks.personId, personId),
        eq(tasks.kind, "failure"),
        eq(tasks.status, "open"),
        eq(jobs.status, "succeeded"),
        inArray(jobs.connectionId, connectionIds),
      ),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.id));
  const ids = rows.map((row) => row.id);
  await closeTasks(ids, "cancelled", { actor, note: "Replaced by a newer workflow." });
  return ids;
}

/**
 * Cancels the workflow and its unfinished jobs. The cancel comes too late
 * for a running job: its change may already have happened in the connected
 * app, so it finishes, and its change counts. Returns those jobs. The lock
 * keeps the worker from claiming a job meanwhile. The caller holds the
 * person's lock, so no running job finishes meanwhile.
 */
export async function stopWorkflow(
  workflow: Pick<Workflow, "id">,
  options: { actor?: Actor; note: string },
): Promise<JobState[]> {
  const unfinished = await q()
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.workflowId, workflow.id), notInArray(jobs.status, [...FINISHED_JOB_STATUSES, "running"])),
    )
    .orderBy(asc(jobs.id))
    .for("update", { of: jobs });
  for (const job of unfinished)
    await cancelJob(await loadState(job), { actor: options.actor ?? null, note: options.note });
  await q()
    .update(workflows)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(workflows.id, workflow.id));
  const running = await q()
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(connections, eq(connections.id, jobs.connectionId))
    .where(and(eq(jobs.workflowId, workflow.id), eq(jobs.status, "running")))
    .orderBy(asc(connections.name), asc(jobs.id));
  const states: JobState[] = [];
  for (const row of running) states.push(await loadState(row.job));
  return states;
}

/**
 * Cancels a job. A job whose account step an earlier run did, so that only
 * its groups were left, ends as done instead: a change that was made is
 * never shown as cancelled, and the cancel stops only the groups.
 */
export async function cancelJob(
  job: JobState,
  options: { actor?: Actor; note?: string } = {},
): Promise<void> {
  const actor = options.actor ?? null;
  const note = options.note ?? "";
  const step = await accountStep(job);
  if (step !== null) {
    await q()
      .update(jobs)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        lockedUntil: null,
        lastError: "",
        result: step.details,
      })
      .where(eq(jobs.id, job.id));
    Object.assign(job, { status: "succeeded", result: step.details });
    await closeTasks(await workTaskIds(job), "cancelled", { actor, note });
    await record(
      `job.${job.action}`,
      `${actionLabel(job)} at ${job.connection.name} for ${fullName(job.person)}: ` +
        "an earlier run already did the account step, so the cancel stopped only the " +
        "groups. They are left as they are.",
      {
        actor,
        personId: job.personId,
        target: target(job),
        details: note ? { note: note.slice(0, 500) } : {},
      },
    );
    return;
  }
  await q()
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date(), lockedUntil: null })
    .where(eq(jobs.id, job.id));
  job.status = "cancelled";
  await closeTasks(await workTaskIds(job), "cancelled", { actor, note });
}

/**
 * The audit event of the account step an earlier run of this open job did,
 * if one did. An open job has one only when that run left the groups for
 * another try, or another worker claimed the job since.
 */
async function accountStep(job: Pick<Job, "id" | "action">): Promise<AuditEvent | null> {
  const [event] = await q()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, `job.${job.action}`),
        eq(auditEvents.targetType, "job"),
        eq(auditEvents.targetId, String(job.id)),
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(1);
  return event ?? null;
}

/**
 * The job's open tasks that stand for its change. Sign-in details for an
 * account the job created must still reach the person, whatever happens to
 * the job afterwards: nothing creates them again.
 */
async function workTaskIds(job: Pick<Job, "id">): Promise<number[]> {
  const rows = await q()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.jobId, job.id), eq(tasks.status, "open"), ne(tasks.kind, "credentials")));
  return rows.map((row) => row.id);
}

/**
 * Derives the workflow's status from its jobs and finishes the person's
 * status change when everything is done. The locks make changes to its jobs
 * take turns here: two jobs that finish at once would each see the other
 * still running, and the workflow would never complete. The person comes
 * first, as when a workflow starts or is cancelled.
 */
export async function refreshWorkflow(workflowId: number): Promise<Workflow> {
  const [current] = await q()
    .select({ personId: workflows.personId })
    .from(workflows)
    .where(eq(workflows.id, workflowId));
  await lockPerson(current!.personId);
  const [locked] = await q().select().from(workflows).where(eq(workflows.id, workflowId)).for("update");
  const workflow = locked!;
  if (workflow.status === "cancelled") return workflow;
  const rows = await q()
    .selectDistinct({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.workflowId, workflowId));
  const statuses = new Set<JobStatus>(rows.map((row) => row.status));
  let status: Workflow["status"];
  if ([...statuses].every((value) => (FINISHED_JOB_STATUSES as readonly string[]).includes(value)))
    status = "completed";
  else if (statuses.has("failed")) status = "failed";
  else if (statuses.has("queued") || statuses.has("running")) status = "running";
  else status = "waiting";
  if (status === workflow.status) return workflow;
  const finishedAt = status === "completed" ? new Date() : null;
  await q().update(workflows).set({ status, finishedAt }).where(eq(workflows.id, workflowId));
  const updated = { ...workflow, status, finishedAt };
  if (status === "completed") await finishPersonStatus(updated);
  return updated;
}

async function finishPersonStatus(workflow: Workflow): Promise<void> {
  const person = await lockPerson(workflow.personId);
  const [latest] = await q()
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.personId, workflow.personId), ne(workflows.status, "cancelled")))
    .orderBy(desc(workflows.createdAt), desc(workflows.id))
    .limit(1);
  if (!latest || latest.id !== workflow.id) return;
  let status: Person["status"];
  if (workflow.kind === "onboarding" && person.status === "onboarding") status = "active";
  else if (workflow.kind === "offboarding" && person.status === "offboarding") status = "offboarded";
  else return;
  await q().update(people).set({ status }).where(eq(people.id, person.id));
  await record("person.status", `${fullName(person)} is now ${PERSON_STATUS_LABELS[status].toLowerCase()}`, {
    personId: person.id,
    target: { type: "workflow", id: workflow.id },
  });
}

/**
 * Completes open workflows whose jobs are all done. Every job change
 * already does this; it catches workflows a crash or an older version of
 * this app left open.
 */
export async function settleFinishedWorkflows(): Promise<number> {
  const stuck = await q()
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        inArray(workflows.status, [...OPEN_WORKFLOW_STATUSES]),
        sql`not exists (select 1 from ${jobs} where ${jobs.workflowId} = ${workflows.id} and ${inArray(jobs.status, [...OPEN_JOB_STATUSES])})`,
      ),
    )
    .orderBy(desc(workflows.createdAt), desc(workflows.id));
  let count = 0;
  for (const { id } of stuck) {
    const workflow = await atomic(() => refreshWorkflow(id));
    if (workflow.status === "completed") count += 1;
  }
  return count;
}

/**
 * Ends every change to a job: works out its workflow's status again, and
 * tells people about new tasks once the change commits.
 */
async function settle(job: Pick<Job, "workflowId">, ...newTasks: (Task | null)[]): Promise<void> {
  await seams.refreshWorkflow(job.workflowId);
  notifyAfterCommit(newTasks);
}

/** Tests only: settle calls refreshWorkflow through this, so a test can intercept it. */
export const seams = { refreshWorkflow };

/** Whether a newer workflow replaced the job's (or it was cancelled). */
async function replaced(job: Pick<Job, "workflowId">): Promise<boolean> {
  const [row] = await q()
    .select({ status: workflows.status })
    .from(workflows)
    .where(eq(workflows.id, job.workflowId));
  return row?.status === "cancelled";
}

/**
 * Whether another worker claimed the job after this claim's lease ran out.
 * That worker's claim, and nothing this one does, settles the job.
 */
function claimedElsewhere(job: Pick<Job, "claim">, claim: Pick<Job, "claim">): boolean {
  return job.claim !== claim.claim;
}

/**
 * Locks a person for a change (NO KEY UPDATE): changes to one person take
 * turns, but never hold up a foreign-key check, such as an account
 * comparison linking an account to the person while it holds the
 * connection's accounts.
 */
export async function lockPerson(personId: number): Promise<Person> {
  const [person] = await q().select().from(people).where(eq(people.id, personId)).for("no key update");
  if (!person) throw new Error(`Person ${personId} does not exist`);
  return person;
}

/**
 * The job, locked for a change. The person comes first, as when a workflow
 * starts, is cancelled or works out its status: with one order everywhere,
 * two changes never wait for each other.
 */
export async function locked(job: Pick<Job, "id" | "personId">): Promise<JobState> {
  await lockPerson(job.personId);
  const [row] = await q().select().from(jobs).where(eq(jobs.id, job.id)).for("update");
  if (!row) throw new Error(`Job ${job.id} does not exist`);
  return loadState(row);
}

async function closeTasks(
  ids: number[],
  status: TaskStatus,
  options: { actor?: Actor; note?: string } = {},
): Promise<void> {
  if (ids.length === 0) return;
  await q()
    .update(tasks)
    .set({
      status,
      completedAt: new Date(),
      completedById: options.actor?.id ?? null,
      note: (options.note ?? "").slice(0, 2000),
    })
    .where(inArray(tasks.id, ids));
}

// -- claiming --------------------------------------------------------------------

export async function claimNextJob(): Promise<JobState | null> {
  const now = new Date();
  return atomic(async () => {
    // A job waits while another job for the same person and app runs, so an
    // older change can never land after a newer one. Locks only the job row,
    // not the workflow the filter joins.
    const [row] = await q()
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
      .where(
        and(
          eq(jobs.status, "queued"),
          lte(jobs.nextAttemptAt, now),
          ne(workflows.status, "cancelled"),
          sql`not exists (select 1 from ${jobs} as busy where busy.status = 'running' and busy.person_id = ${jobs.personId} and busy.connection_id = ${jobs.connectionId})`,
        ),
      )
      .orderBy(asc(jobs.nextAttemptAt), asc(jobs.id))
      .limit(1)
      .for("update", { of: jobs, skipLocked: true });
    if (!row) return null;
    const values = {
      status: "running" as const,
      attempts: row.job.attempts + 1,
      lockedUntil: new Date(now.getTime() + config().JOB_LEASE_SECONDS * 1000),
      claim: randomUUID(),
    };
    await q().update(jobs).set(values).where(eq(jobs.id, row.job.id));
    return loadState({ ...row.job, ...values });
  });
}

/**
 * Jobs whose worker stopped mid-run go back to the queue. The adapter
 * operations are idempotent, so running one again is safe.
 */
export async function recoverStaleJobs(): Promise<number> {
  let count = 0;
  const stale = await q()
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedUntil, new Date())))
    .orderBy(asc(jobs.id));
  for (const candidate of stale) {
    await atomic(async () => {
      const job = await locked(candidate);
      // Another worker may have recovered and claimed it again meanwhile: only
      // the claim that was seen expired, and is still expired, goes back.
      if (job.status !== "running" || job.claim !== candidate.claim) return;
      if (!job.lockedUntil || job.lockedUntil >= new Date()) return;
      if (await replaced(job)) {
        await cancelJob(job, { note: "The worker stopped; the workflow was replaced meanwhile." });
        await settle(job);
        count += 1;
        return;
      }
      await q()
        .update(jobs)
        .set({
          status: "queued",
          lockedUntil: null,
          nextAttemptAt: new Date(),
          lastError: "The worker stopped while running this job; it runs again.",
          // The next run checks whether this one created an account it never recorded.
          result: { ...job.result, interrupted: true },
        })
        .where(eq(jobs.id, job.id));
      count += 1;
    });
  }
  return count;
}

// -- running ---------------------------------------------------------------------

/**
 * What an attempt found:
 * - changed: the connection made the job's change: the account step is
 *   done, and the groups are done or carry the error that stopped them;
 * - failed: the connection did not make the change (the message is safe to show);
 * - for a person: the connection no longer changes accounts automatically;
 * - rehearsed: read-only mode, what the job would change. Nothing changed.
 */
export type Outcome =
  | { type: "changed"; result: EnsureResult | DisableResult }
  | { type: "failed"; message: string; retryable: boolean }
  | { type: "for a person" }
  | { type: "rehearsed"; plan: Record<string, unknown> };

type Failed = Extract<Outcome, { type: "failed" }>;
const failed = (message: string, retryable: boolean): Failed => ({ type: "failed", message, retryable });

/** Runs a job the worker claimed: attempt, then finish. */
export async function runJob(claim: JobState): Promise<JobState> {
  return finish(claim, await attempt(claim));
}

/**
 * Makes the job's change at its connection, or in read-only mode finds out
 * what it would change. Writes nothing in this app: finish records the
 * outcome. Every failure becomes `failed` with a message safe to show; an
 * unexpected one also goes to the worker log and Sentry.
 */
export async function attempt(job: Job): Promise<Outcome> {
  const [connection] = await q().select().from(connections).where(eq(connections.id, job.connectionId));
  const [person] = await q().select().from(people).where(eq(people.id, job.personId));
  const state: JobState = { ...job, connection: connection!, person: person! };
  if (!writesAutomatically(state.connection) || !canWrite(state.connection)) {
    if (config().READ_ONLY) {
      return {
        type: "rehearsed",
        plan: { would: "ask a person to make the change", steps: await manualSteps(state) },
      };
    }
    return { type: "for a person" };
  }
  let result: EnsureResult | DisableResult;
  try {
    if (config().READ_ONLY) return { type: "rehearsed", plan: await rehearseChange(state) };
    result = await change(state);
  } catch (error) {
    if (error instanceof AdapterError) return failed(error.message, error.retryable);
    if (error instanceof SecretUnreadable) return failed(error.message, false);
    logger.error(
      { err: error, jobId: job.id },
      config().READ_ONLY ? "rehearsal of a job failed unexpectedly" : "job failed unexpectedly",
    );
    reportError(error);
    return failed(`Unexpected error (${errorName(error)}). The details are in the worker log.`, false);
  }
  const error = result.groupError;
  if (error !== null && !(error instanceof AdapterError)) {
    logger.error({ err: error, jobId: job.id }, "the group step of a job failed unexpectedly");
    reportError(error);
  }
  return { type: "changed", result };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

async function change(job: JobState): Promise<EnsureResult | DisableResult> {
  const spec = await accountSpecOf(job.person);
  const adapter = buildAdapter(job.connection);
  // Check whose account the app is about to change before changing it.
  const { externalId, found } = await checkedAccount(adapter, job.connection, job.person, spec);
  // Hand over the account whose owner was checked, so the change cannot land
  // on another account a second lookup finds.
  if (job.action === "disable_account") {
    return adapter.disableAccount(spec, { externalId, managedGroups: await managedGroups(job), found });
  }
  const result = await adapter.ensureAccount(spec, {
    externalId,
    groups: new Set(job.groups),
    managedGroups: await managedGroups(job),
    found,
  });
  if (await createdByAStoppedWorker(job, adapter, found, result)) {
    result.credentialsProblem = lostSignIn(job.connection, job.person);
  }
  return result;
}

/**
 * Records what an attempt found: the only code that settles a job the worker
 * claimed. It locks the person, then the job.
 *
 * - A change the connection made always counts: the account is recorded and
 *   audited even when a newer workflow replaced the job's, or another worker
 *   claimed the job since. The job succeeds unless another worker holds the
 *   latest claim, also when it was cancelled while it ran: that cancel came
 *   too late, and the audit says so. A group error that may clear on its own
 *   runs the job again instead, until the last attempt, unless the job was
 *   cancelled. An account linked to someone else meanwhile fails the job, as
 *   any other failure.
 * - Any other outcome settles only a job that is still open and still this
 *   claim's. A job whose workflow was replaced or cancelled is cancelled.
 *
 * A new account's sign-in details reach the person after the commit.
 */
export async function finish(claim: JobState, outcome: Outcome): Promise<JobState> {
  let signIn: EnsureResult | DisableResult | null = null;
  const job = await atomic(async () => {
    const current = await locked(claim);
    let left: Outcome | null = outcome;
    if (outcome.type === "changed") {
      const recorded = await recordChange(current, claim, outcome.result);
      left = recorded.left;
      signIn = recorded.signIn;
    }
    if (left !== null) await settleClaim(current, claim, left);
    return current;
  });
  if (signIn !== null) await handOverSignIn(job, signIn);
  return job;
}

/**
 * Finds the person's account the way a job does and checks that it is
 * theirs. Returns the ID of the account to change and what the adapter
 * found. An account linked to someone else throws AdapterError: nothing may
 * change it.
 */
async function checkedAccount(
  adapter: Adapter,
  connection: Connection,
  person: Person,
  spec: AccountSpec,
): Promise<{ externalId: string; found: ExternalAccount | null }> {
  const [account] = await q()
    .select({ externalId: accounts.externalId })
    .from(accounts)
    .where(and(eq(accounts.connectionId, connection.id), eq(accounts.personId, person.id)))
    .limit(1);
  let externalId = account?.externalId ?? "";
  const found = await adapter.findAccount(spec, externalId);
  if (found !== null && found.externalId) {
    const owner = await accountsLedger.otherOwner(connection.id, found.externalId, person.id);
    if (owner !== null) {
      throw new AdapterError(
        `The ${connection.name} account ${found.username || found.externalId} ` +
          `belongs to ${fullName(owner)}. Nothing was changed. Check the work email and username.`,
      );
    }
    externalId = found.externalId;
  }
  return { externalId, found };
}

/**
 * Whether the account may be one that a worker created and stopped before
 * recording: the job ran before and was interrupted, and it finds an
 * account the app does not know as the person's. The sign-in details that
 * worker arranged never reached anyone.
 */
async function createdByAStoppedWorker(
  job: JobState,
  adapter: Adapter,
  found: ExternalAccount | null,
  result: EnsureResult,
): Promise<boolean> {
  if (
    !job.result.interrupted ||
    found === null ||
    result.created ||
    result.initialPassword ||
    result.credentialsProblem ||
    !adapter.handsOutSignIn()
  ) {
    return false;
  }
  const known = await q()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.connectionId, job.connectionId),
        eq(accounts.personId, job.personId),
        eq(accounts.externalId, found.externalId),
      ),
    )
    .limit(1);
  return known.length === 0;
}

function lostSignIn(connection: Connection, person: Person): string {
  return (
    `The worker stopped while it set up the ${connection.name} account of ` +
    `${fullName(person)}, after the account was created. The sign-in details it ` +
    "arranged (an initial password or a setup email) may never have reached them. Ask " +
    `whether they can sign in; if not, set a new temporary password in ` +
    `${connection.name} or send its setup email again, and hand it over in a safe way.`
  );
}

function groupErrorMessage(error: Error): string {
  if (error instanceof AdapterError) return error.message;
  return `Unexpected error (${errorName(error)}). The details are in the worker log.`;
}

function canWrite(connection: Connection): boolean {
  const cls = adapterClassOf(connection);
  return Boolean(cls && cls.kind === AdapterKind.PROVISIONING && cls.supportsWrite);
}

/**
 * Records a change the connection made. Returns what is left to settle, if
 * anything, and the result whose sign-in details must reach the person.
 */
async function recordChange(
  job: JobState,
  claim: JobState,
  result: EnsureResult | DisableResult,
): Promise<{ left: Failed | null; signIn: EnsureResult | DisableResult | null }> {
  const error = result.groupError;
  const tooLate = await cancelTooLate(job, claim);
  // A cancelled job does not run again for its groups.
  const groupsPending =
    error instanceof AdapterError && error.retryable && claim.attempts < MAX_ATTEMPTS && !tooLate;
  // IAM must know a new account even if a newer workflow replaces this job. A
  // disabled account stays active in IAM until its groups are done, so a
  // newer workflow still plans a job there.
  if (result.kind === "ensure" || !groupsPending) {
    try {
      await atomic(() => accountsLedger.recordJobResult(job, result));
    } catch (exception) {
      if (exception instanceof accountsLedger.AccountConflict) {
        return { left: failed(exception.message, false), signIn: null };
      }
      throw exception;
    }
  }
  if (groupsPending) {
    // A cancel before the run for the groups comes too late for the account:
    // this event tells cancelJob so (accountStep).
    await record(`job.${job.action}`, `${successSummary(job, result)}. The groups are not done yet.`, {
      personId: job.personId,
      target: target(job),
      details: resultSummary(result),
    });
    // The job runs again for the groups. A new account's password must reach
    // the person now: the next run finds the account and generates none.
    return { left: failed(error.message, true), signIn: result };
  }
  // A worker that claimed the job again since then settles it.
  const current = !claimedElsewhere(job, claim);
  let groupTask: Task | null = null;
  if (current) {
    const summary = resultSummary(result);
    await q()
      .update(jobs)
      .set({ status: "succeeded", finishedAt: new Date(), lockedUntil: null, lastError: "", result: summary })
      .where(eq(jobs.id, job.id));
    Object.assign(job, { status: "succeeded", result: summary, lastError: "" });
    const failures = await q()
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.jobId, job.id), eq(tasks.status, "open"), eq(tasks.kind, "failure")));
    await closeTasks(
      failures.map((row) => row.id),
      "done",
      { note: "Resolved by a retry." },
    );
    if (error !== null && (await workflowIsCurrent(job))) groupTask = await openGroupTask(job, error);
  }
  const summary = successSummary(job, result);
  await record(`job.${job.action}`, tooLate ? `${summary}. ${tooLate}` : summary, {
    personId: job.personId,
    target: target(job),
    details: resultSummary(result),
  });
  if (current) await settle(job, groupTask);
  return { left: null, signIn: result };
}

/**
 * Why a cancel came too late for the change this claim made, if one did:
 * the job or its workflow was cancelled while the job ran.
 */
async function cancelTooLate(job: JobState, claim: JobState): Promise<string> {
  if (claimedElsewhere(job, claim)) return "";
  if (job.status === "cancelled") return "It was cancelled while it ran, too late to stop the change.";
  if (await replaced(job))
    return "Its workflow was cancelled or replaced while it ran, too late to stop the change.";
  return "";
}

export function resultSummary(result: EnsureResult | DisableResult): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    groups_removed: [...result.groupsRemoved],
    notes: [...result.notes],
  };
  if (result.groupError !== null) summary.group_error = groupErrorMessage(result.groupError).slice(0, 500);
  if (result.kind === "ensure") {
    Object.assign(summary, {
      created: result.created,
      reactivated: result.reactivated,
      groups_added: [...result.groupsAdded],
      password_generated: Boolean(result.initialPassword),
    });
  } else {
    Object.assign(summary, { changed: result.changed, found: result.account !== null });
  }
  if (result.account !== null) {
    summary.account = result.account.username || result.account.email || result.account.externalId;
  }
  return summary;
}

function successSummary(job: JobState, result: EnsureResult | DisableResult): string {
  const name = `${job.connection.name} account of ${fullName(job.person)}`;
  if (result.kind === "ensure") {
    const verb = result.created ? "Created" : result.reactivated ? "Reactivated" : "Checked";
    return `${verb} the ${name}`;
  }
  if (result.account === null) return `No ${name} to disable`;
  return result.changed ? `Disabled the ${name}` : `The ${name} was already disabled`;
}

/** Settles a job whose attempt changed nothing at the connection. */
async function settleClaim(job: JobState, claim: JobState, outcome: Outcome): Promise<void> {
  if (job.status !== "running" && job.status !== "queued") return;
  if (claimedElsewhere(job, claim)) return;
  if (await replaced(job)) {
    const note =
      outcome.type === "failed"
        ? `Replaced by a newer workflow after: ${outcome.message.slice(0, 500)}`
        : "Replaced by a newer workflow.";
    await cancelJob(job, { note });
    await settle(job);
  } else if (outcome.type === "failed") {
    await fail(job, outcome.message, outcome.retryable);
  } else if (outcome.type === "for a person") {
    await settle(job, await handToPerson(job));
  } else if (outcome.type === "rehearsed") {
    await rehearsed(job, outcome.plan);
  }
}

/** Runs the job again after a pause, or hands it to a person. */
async function fail(job: JobState, message: string, retryable: boolean): Promise<void> {
  const lastError = message.slice(0, 2000);
  if (retryable && job.attempts < MAX_ATTEMPTS) {
    await q()
      .update(jobs)
      .set({
        status: "queued",
        lastError,
        lockedUntil: null,
        nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts)),
      })
      .where(eq(jobs.id, job.id));
    return;
  }
  await q().update(jobs).set({ status: "failed", lastError, lockedUntil: null }).where(eq(jobs.id, job.id));
  Object.assign(job, { status: "failed", lastError });
  const task = await openTask(
    job,
    "failure",
    `Fix: ${actionLabel(job).toLowerCase()} at ${job.connection.name} for ${fullName(job.person)}`,
    [
      `The app stopped after ${job.attempts} attempt(s): ${message}`,
      "Fix the cause and press Retry on the job, or make the change by hand and complete this task.",
      await manualSteps(job),
    ].join("\n\n"),
  );
  await record(
    "job.failed",
    `${actionLabel(job)} at ${job.connection.name} for ${fullName(job.person)} failed`,
    {
      personId: job.personId,
      target: target(job),
      details: { error: message.slice(0, 500), attempts: job.attempts },
    },
  );
  await settle(job, task);
}

/**
 * Whether no newer workflow replaced the job's. Takes the person lock that
 * starting a workflow takes: a newer one either replaced this one already,
 * or starts after this commits and cancels its group task if it plans a job
 * at the same connection.
 */
async function workflowIsCurrent(job: JobState): Promise<boolean> {
  await lockPerson(job.personId);
  const [row] = await q()
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, job.workflowId), ne(workflows.status, "cancelled")));
  return row !== undefined;
}

/** The account step is done; hands the unfinished groups to a person. */
async function openGroupTask(job: JobState, error: Error): Promise<Task | null> {
  const cls = adapterClassOf(job.connection);
  const label = cls ? cls.groupLabel : "Groups";
  const disabling = job.action === "disable_account";
  const done = disabling ? "is disabled" : "is ready";
  const steps: string[] = [];
  if (!disabling && job.groups.length > 0) {
    steps.push(`Make sure they are in: ${(await groupLabels(job)).sort().join(", ")}.`);
  }
  const wanted = new Set(job.groups);
  const remove = await groupNames(
    job,
    [...(await managedGroups(job))].filter((group) => !wanted.has(group)),
  );
  if (remove) steps.push(`Remove them from these, if a member: ${remove}.`);
  return openTask(
    job,
    "failure",
    `Fix: ${label} of ${fullName(job.person)} at ${job.connection.name}`,
    [
      `The ${job.connection.name} account ${done}, but the app could not update its ${label}: ${groupErrorMessage(error)}`,
      "Fix the cause, make these changes by hand, then complete this task.",
      steps.join("\n"),
    ].join("\n\n"),
  );
}

async function groupNames(job: Pick<Job, "connectionId">, ids: string[]): Promise<string> {
  const names = await groupNameMap(job.connectionId, ids);
  return ids
    .map((id) => names.get(id) ?? id)
    .sort()
    .join(", ");
}

async function manualSteps(job: JobState): Promise<string> {
  let steps: string;
  try {
    const adapter = buildAdapter(job.connection);
    steps = adapter.manualInstructions(job.action, await accountSpecOf(job.person), await groupLabels(job));
  } catch {
    // Instructions are best effort.
    const verb = job.action === "disable_account" ? "Disable" : "Create or update";
    steps = `${verb} the ${job.connection.name} account of ${fullName(job.person)}.`;
  }
  const wanted = new Set(job.groups);
  const remove = [...(await managedGroups(job))].filter((group) => !wanted.has(group));
  if (job.action === "ensure_account" && remove.length > 0) {
    steps += `\nRemove from these, if a member: ${await groupNames(job, remove)}.`;
  }
  return steps;
}

async function openTask(
  job: JobState,
  kind: TaskKind,
  title: string,
  instructions: string,
): Promise<Task | null> {
  const [existing] = await q()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.jobId, job.id), eq(tasks.status, "open"), eq(tasks.kind, kind)))
    .limit(1);
  if (existing) {
    await q().update(tasks).set({ instructions }).where(eq(tasks.id, existing.id));
    return null;
  }
  const [task] = await q()
    .insert(tasks)
    .values({
      kind,
      title: title.slice(0, 300),
      instructions,
      personId: job.personId,
      jobId: job.id,
      connectionId: job.connectionId,
    })
    .returning();
  return task!;
}

// -- read-only mode ----------------------------------------------------------------

/**
 * Read-only mode: records what the job would change. At a connection that
 * changes accounts automatically, attempt read the account and its groups as
 * the job would; anywhere else the plan holds the steps a person would get,
 * and nobody gets a task. A read that fails is a failed job, so it shows
 * where real failures show.
 */
async function rehearsed(job: JobState, plan: Record<string, unknown>): Promise<void> {
  await q()
    .update(jobs)
    .set({ status: "rehearsed", finishedAt: new Date(), lockedUntil: null, lastError: "", result: plan })
    .where(eq(jobs.id, job.id));
  await record(
    "job.rehearsed",
    `Read-only mode: checked ${actionLabel(job).toLowerCase()} at ${job.connection.name} for ` +
      `${fullName(job.person)} and changed nothing`,
    { personId: job.personId, target: target(job), details: plan },
  );
  await settle(job);
}

/**
 * What the job's adapter call would do: the plan the adapter follows when it
 * runs the job, made from reads alone. Where the job would fail, the
 * rehearsal fails with the same message.
 */
async function rehearseChange(job: JobState): Promise<Record<string, unknown>> {
  const adapter = buildAdapter(job.connection);
  const spec = await accountSpecOf(job.person);
  const { found } = await checkedAccount(adapter, job.connection, job.person, spec);
  const plan = await adapter.plan(job.action, spec, {
    found,
    groups: new Set(job.groups),
    managedGroups: await managedGroups(job),
  });
  if (plan.refusal) {
    const removed = await groupNames(job, plan.groupsToRemove ?? []);
    const first = removed ? ` The job would remove these groups first: ${removed}.` : "";
    throw new AdapterError(plan.refusal + first);
  }
  const result: Record<string, unknown> = {};
  if (found !== null) result.account = found.username || found.email || found.externalId;
  result.would = REHEARSED_CHANGES[plan.change];
  if (plan.also.length > 0) result.also = plan.also.join(", ");
  if (plan.groupsToAdd !== null) {
    result.groups_to_add = (await groupNames(job, plan.groupsToAdd)) || "none";
    result.groups_to_remove = (await groupNames(job, plan.groupsToRemove ?? [])) || "none";
  }
  return result;
}

export const REHEARSED_CHANGES: Record<string, string> = {
  create: "create the account",
  reactivate: "reactivate the account",
  keep: "keep the account",
  disable: "disable the account",
  delete: "delete the account",
  "already disabled": "disable the account (already disabled)",
  "no account": "change nothing: no account found",
};

/** Turns a job at a connection without automation into a manual task. */
async function handToPerson(job: JobState): Promise<Task | null> {
  await q().update(jobs).set({ status: "manual", lockedUntil: null }).where(eq(jobs.id, job.id));
  job.status = "manual";
  const disabling = job.action === "disable_account";
  const title = `${disabling ? "Remove" : "Give"} ${fullName(job.person)} ${disabling ? "from" : "access to"} ${job.connection.name}`;
  let reason = "";
  if (!job.connection.enabled) reason = "The connection is turned off, so the app makes no changes there.";
  else if (job.connection.mode === "read_only")
    reason = "The connection is read only, so the app makes no changes there.";
  const instructions = [reason, await manualSteps(job)].filter(Boolean).join("\n\n");
  return openTask(job, "change", title, instructions);
}

// -- operator actions --------------------------------------------------------------

/** An operator's action cannot run; the message says why. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export async function retryJob(jobId: number, options: { actor: User }): Promise<void> {
  await atomic(async () => {
    const job = await locked(await jobRef(jobId));
    if (job.status !== "failed" && job.status !== "manual") {
      throw new ActionError("Only failed jobs and jobs with a manual task can run again.");
    }
    if (await replaced(job))
      throw new ActionError("The workflow was replaced or cancelled; start a new one instead.");
    await q()
      .update(jobs)
      .set({ status: "queued", attempts: 0, nextAttemptAt: new Date() })
      .where(eq(jobs.id, job.id));
    await closeTasks(await workTaskIds(job), "cancelled", {
      actor: options.actor,
      note: "The job runs again.",
    });
    await record("job.retry", `Retried: ${jobLabel(job)}`, {
      actor: options.actor,
      personId: job.personId,
      target: target(job),
    });
    await settle(job);
  });
}

export async function approveJob(jobId: number, options: { actor: User }): Promise<void> {
  await atomic(async () => {
    const job = await locked(await jobRef(jobId));
    if (job.status !== "held") throw new ActionError("This job is not waiting for approval.");
    await q()
      .update(jobs)
      .set({ status: "queued", nextAttemptAt: new Date(), lastError: "" })
      .where(eq(jobs.id, job.id));
    await record("job.approved", `Approved: ${jobLabel(job)}`, {
      actor: options.actor,
      personId: job.personId,
      target: target(job),
    });
    await settle(job);
  });
}

export async function rejectJob(jobId: number, options: { actor: User }): Promise<void> {
  await atomic(async () => {
    const job = await locked(await jobRef(jobId));
    if (job.status !== "held") throw new ActionError("This job is not waiting for approval.");
    await cancelJob(job, { actor: options.actor, note: "Rejected by an admin." });
    await record("job.rejected", `Rejected: ${jobLabel(job)}`, {
      actor: options.actor,
      personId: job.personId,
      target: target(job),
    });
    await settle(job);
  });
}

async function jobRef(jobId: number): Promise<Pick<Job, "id" | "personId">> {
  const [row] = await q()
    .select({ id: jobs.id, personId: jobs.personId })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  if (!row) throw new ActionError("This job does not exist.");
  return row;
}

async function lockedTask(taskId: number): Promise<Task> {
  const [ref] = await q().select({ personId: tasks.personId }).from(tasks).where(eq(tasks.id, taskId));
  if (!ref) throw new ActionError("This task does not exist.");
  if (ref.personId !== null) await lockPerson(ref.personId);
  const [task] = await q().select().from(tasks).where(eq(tasks.id, taskId)).for("update");
  return task!;
}

async function openJobOfTask(task: Task): Promise<JobState | null> {
  if (task.jobId === null) return null;
  const job = await loadJob(task.jobId);
  return job && (OPEN_JOB_STATUSES as readonly string[]).includes(job.status) ? job : null;
}

export async function completeTask(taskId: number, options: { actor: User; note?: string }): Promise<void> {
  const note = options.note ?? "";
  await atomic(async () => {
    const task = await lockedTask(taskId);
    if (task.status !== "open") throw new ActionError("This task is already closed.");
    await closeTasks([task.id], "done", { actor: options.actor, note });
    const job = task.kind === "change" || task.kind === "failure" ? await openJobOfTask(task) : null;
    if (job !== null) {
      const result = { ...job.result, manual: true, completed_by: options.actor.email };
      await q()
        .update(jobs)
        .set({ status: "succeeded", finishedAt: new Date(), result })
        .where(eq(jobs.id, job.id));
      await accountsLedger.recordManualChange(job);
      await settle(job);
    }
    await record("task.done", `Completed task: ${task.title}`, {
      actor: options.actor,
      personId: task.personId,
      target: { type: "task", id: task.id },
      details: note ? { note: note.slice(0, 500) } : {},
    });
  });
}

export async function cancelTask(taskId: number, options: { actor: User; note?: string }): Promise<void> {
  const note = options.note ?? "";
  await atomic(async () => {
    const task = await lockedTask(taskId);
    if (task.status !== "open") throw new ActionError("This task is already closed.");
    const job = task.kind === "change" || task.kind === "failure" ? await openJobOfTask(task) : null;
    if (job !== null) {
      await cancelJob(job, { actor: options.actor, note: note || "Task cancelled." });
      await settle(job);
    } else {
      await closeTasks([task.id], "cancelled", { actor: options.actor, note });
    }
    await record("task.cancelled", `Cancelled task: ${task.title}`, {
      actor: options.actor,
      personId: task.personId,
      target: { type: "task", id: task.id },
      details: note ? { note: note.slice(0, 500) } : {},
    });
  });
}

// -- email -----------------------------------------------------------------------------

/**
 * Gets a new account's first sign-in to the person: emails the initial
 * password, or asks a person to arrange what the adapter could not.
 */
export async function handOverSignIn(job: JobState, result: EnsureResult | DisableResult): Promise<void> {
  if (result.kind !== "ensure") return;
  if (result.initialPassword) await deliverInitialPassword(job, result.initialPassword);
  else if (result.credentialsProblem) await openCredentialsTask(job, result.credentialsProblem);
}

async function openCredentialsTask(job: JobState, instructions: string): Promise<void> {
  const [task] = await q()
    .insert(tasks)
    .values({
      kind: "credentials",
      title: `Hand over ${job.connection.name} sign-in details to ${fullName(job.person)}`.slice(0, 300),
      instructions,
      personId: job.personId,
      jobId: job.id,
      connectionId: job.connectionId,
    })
    .returning();
  notifyAfterCommit([task!]);
}

export async function deliverInitialPassword(job: JobState, password: string): Promise<void> {
  const person = job.person;
  const organization = (await loadSettings()).organizationName;
  const sent =
    Boolean(person.personalEmail) &&
    (await sendEmail(
      [person.personalEmail],
      `Your ${job.connection.name} account at ${organization}`,
      [
        `Hello ${person.firstName},`,
        "",
        `Your ${job.connection.name} account is ready.`,
        `Sign-in: ${person.workEmail || loginName(person)}`,
        `Initial password: ${password}`,
        "",
        "You will be asked to choose a new password when you first sign in.",
      ].join("\n"),
    ));
  if (sent) {
    await record(
      "credentials.sent",
      `Emailed the initial ${job.connection.name} password of ${fullName(person)} ` +
        `to the personal address ${maskEmail(person.personalEmail)}`,
      { personId: person.id, target: target(job) },
    );
    return;
  }
  await openCredentialsTask(
    job,
    `The app created the ${job.connection.name} account but could not email the ` +
      "initial password (no email connection or no personal email address). The " +
      `password was not stored. Set a new temporary password in ${job.connection.name} ` +
      "and give it to the person in a safe way.",
  );
}

/** Tells people about new tasks once the change commits. */
export function notifyAfterCommit(newTasks: (Pick<Task, "title"> | null)[]): void {
  const created = newTasks.filter((task): task is Pick<Task, "title"> => task !== null);
  if (created.length === 0) return;
  onCommit(() => notifyTasks(created));
}

export { OPEN_JOB_STATUSES };
