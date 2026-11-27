import { and, asc, eq, gte, inArray, notInArray } from "drizzle-orm";
import {
  OPEN_WORKFLOW_STATUSES,
  PERSON_STATUS_LABELS,
  ROLE_LABELS,
  ROLE_RANK,
  WORKFLOW_KIND_LABELS,
} from "@iam/shared/labels";
import {
  accounts,
  jobs,
  people,
  sessions,
  users,
  workflows,
  type Connection,
  type Job,
  type Person,
  type PersonStatus,
  type User,
  type Workflow,
  type WorkflowKind,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import { addDays, formatDate, today } from "../core/time";
import { removableGroups } from "./accounts";
import { isOperator, record, userIdOf, type Operator } from "./audit";
import { lockPerson, refreshWorkflow, startJobs, stopWorkflow, type JobState } from "./jobs";
import { fullName } from "./people";
import { desiredAccess, entitledAccess, managedGroupIds, provisioningConnections, snapshot } from "./policy";
import { loadSettings } from "./settings";

/**
 * Workflows: onboarding, access updates and offboarding of one person.
 *
 * Starting a workflow captures the person's desired access and plans one
 * job per connection: make sure the account exists with the right groups, or
 * disable it. From there src/engine/jobs.ts owns the jobs, their tasks and
 * the workflow's status: the worker runs the jobs, connections that cannot or
 * may not change accounts get a manual task instead, and the person's status
 * finishes when the workflow completes. This module plans jobs as queued, or
 * held for an admin's approval, and never changes the status of a job, a task
 * or a workflow after that.
 */

/** A workflow cannot start; the message explains why. */
export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

/**
 * The person's statuses each workflow may start from. During onboarding, an
 * access update restarts the onboarding (see startWorkflow).
 */
export const ALLOWED_FROM: Record<WorkflowKind, PersonStatus[]> = {
  onboarding: ["planned", "offboarded", "archived"],
  access_update: ["onboarding", "active"],
  offboarding: ["planned", "onboarding", "active", "offboarding", "offboarded"],
};

const STATUS_DURING: Partial<Record<WorkflowKind, PersonStatus>> = {
  onboarding: "onboarding",
  offboarding: "offboarding",
};

const ARCHIVABLE: PersonStatus[] = ["planned", "offboarded"];

/** An app user, the operator (`cli`, with an admin's rights), or nobody: the schedule. */
type Actor = Pick<User, "id" | "email" | "role"> | Operator | null;

/** Whether a workflow of this kind may start for the person now. */
export function canStart(person: Pick<Person, "status">, kind: WorkflowKind): boolean {
  return ALLOWED_FROM[kind].includes(person.status);
}

export async function canArchive(person: Pick<Person, "id" | "status">): Promise<boolean> {
  return ARCHIVABLE.includes(person.status) && !(await hasOpenWorkflow(person.id));
}

async function hasOpenWorkflow(personId: number): Promise<boolean> {
  const rows = await q()
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.personId, personId), inArray(workflows.status, [...OPEN_WORKFLOW_STATUSES])))
    .limit(1);
  return rows.length > 0;
}

export async function startWorkflow(
  personId: number,
  requested: WorkflowKind,
  options: { actor?: Actor; automatic?: boolean; reason?: string } = {},
): Promise<Workflow> {
  const actor = options.actor ?? null;
  const automatic = options.automatic ?? false;
  let reason = options.reason ?? "";
  let kind = requested;
  return atomic(async () => {
    const person = await lockPerson(personId);
    if (!canStart(person, kind)) {
      throw new LifecycleError(
        `${WORKFLOW_KIND_LABELS[kind]} cannot start while ${fullName(person)} is ` +
          `${PERSON_STATUS_LABELS[person.status].toLowerCase()}.`,
      );
    }
    if (kind === "onboarding" && person.endDate && person.endDate < today()) {
      // The schedule would offboard the person right after.
      throw new LifecycleError(
        `The last day of ${fullName(person)} (${formatDate(person.endDate)}) has passed. ` +
          "Clear or change it before onboarding.",
      );
    }
    if (kind === "onboarding" && automatic) {
      // The schedule chose the person a moment ago: under the lock, the
      // onboarding must still be due (a postponed start date, or a cancel
      // that paused it, stops it).
      const settings = await loadSettings();
      const horizon = addDays(today(), settings.onboardingLeadDays);
      if (
        !settings.automaticOnboarding ||
        person.status !== "planned" ||
        person.onboardingPaused ||
        !person.startDate ||
        person.startDate > horizon
      ) {
        throw new LifecycleError("Onboarding is no longer due.");
      }
      reason = `starts on ${formatDate(person.startDate)}`;
    }
    if (kind === "access_update" && person.status === "onboarding") {
      // Applying access during onboarding restarts the onboarding with the new
      // access, so the person still becomes active at its end.
      kind = "onboarding";
    }
    // Every workflow can disable accounts (offboarding all of them, the others
    // where access was taken away): nobody starts one for someone with a higher
    // role in this app than their own.
    // The operator has an admin's rights, and no app user has a higher role.
    if (actor !== null && !isOperator(actor)) await checkMayChange(person, actor, kind);
    if (kind === "offboarding") {
      if (automatic) {
        // The last day may have changed since the schedule selected this person.
        if (!person.endDate || person.endDate >= today()) {
          throw new LifecycleError("The person's last day has not passed.");
        }
        reason = `last day was ${formatDate(person.endDate)}`;
      }
    }
    if (kind === "onboarding" && person.accessProfileId === null) {
      throw new LifecycleError("Choose an access profile before onboarding.");
    }
    const superseded = await supersedeOpenWorkflows(person.id);
    const during = STATUS_DURING[kind];
    if (during) {
      await q()
        .update(people)
        .set({ status: during, onboardingPaused: false })
        .where(eq(people.id, person.id));
      person.status = during;
      person.onboardingPaused = false;
    }
    if (kind === "offboarding") await deactivateAppUser(person, actor);
    const [workflow] = await q()
      .insert(workflows)
      .values({
        personId: person.id,
        kind,
        desired: await snapshot(person),
        automatic,
        reason: reason.slice(0, 300),
        createdById: userIdOf(actor),
      })
      .returning();
    const planned = await planJobs(workflow!, person);
    const cancelledTasks = await startJobs(person.id, planned, { actor });
    await record(
      `workflow.${kind}`,
      `Started ${WORKFLOW_KIND_LABELS[kind].toLowerCase()} of ${fullName(person)}` +
        (reason ? ` (${reason})` : ""),
      {
        actor,
        personId: person.id,
        target: { type: "workflow", id: workflow!.id },
        details: {
          jobs: planned.length,
          automatic,
          superseded_workflows: superseded,
          cancelled_group_tasks: cancelledTasks,
        },
      },
    );
    // After the audit event: a workflow without jobs completes at once.
    return refreshWorkflow(workflow!.id);
  });
}

/** Cancels the person's open workflows. As in the Django version, without the actor: the new workflow records who started it. */
async function supersedeOpenWorkflows(personId: number): Promise<number[]> {
  const open = await q()
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.personId, personId), inArray(workflows.status, [...OPEN_WORKFLOW_STATUSES])))
    .orderBy(asc(workflows.createdAt), asc(workflows.id));
  const ids: number[] = [];
  for (const workflow of open) {
    await stopWorkflow(workflow, { note: "Replaced by a newer workflow." });
    ids.push(workflow.id);
  }
  return ids;
}

export async function higherRoleAppUser(
  person: Pick<Person, "id">,
  actor: Pick<User, "role">,
): Promise<User | null> {
  const [user] = await q()
    .select()
    .from(users)
    .where(and(eq(users.personId, person.id), eq(users.isActive, true)))
    .limit(1);
  if (user && (ROLE_RANK[user.role] ?? 0) > (ROLE_RANK[actor.role] ?? 0)) return user;
  return null;
}

/**
 * Offboarding turns off the person's app user, and every workflow may
 * disable their accounts (the sign-in provider's too), so nobody may start
 * one for someone with a higher role in this app than their own. The
 * schedule (no actor) still offboards everyone after their last day.
 */
async function checkMayChange(person: Person, actor: Pick<User, "role">, kind: WorkflowKind): Promise<void> {
  const user = await higherRoleAppUser(person, actor);
  if (user) {
    throw new LifecycleError(
      `${fullName(person)} is ${withArticle(ROLE_LABELS[user.role].toLowerCase())} of this ` +
        `app. Only someone with that role can start the ${WORKFLOW_KIND_LABELS[kind].toLowerCase()}.`,
    );
  }
}

function withArticle(noun: string): string {
  return `${"aeiou".includes(noun.slice(0, 1)) ? "an" : "a"} ${noun}`;
}

async function deactivateAppUser(person: Person, actor: Actor): Promise<void> {
  const [user] = await q()
    .select()
    .from(users)
    .where(and(eq(users.personId, person.id), eq(users.isActive, true)))
    .limit(1);
  if (!user) return;
  await q().update(users).set({ isActive: false }).where(eq(users.id, user.id));
  // Turned on again later, the user signs in anew.
  await q().delete(sessions).where(eq(sessions.userId, user.id));
  await record(
    "user.deactivated",
    `Deactivated app user ${user.email} because ${fullName(person)} is offboarded`,
    {
      actor,
      personId: person.id,
      target: { type: "user", id: user.id },
    },
  );
}

async function planJobs(workflow: Workflow, person: Person): Promise<JobState[]> {
  const offboarding = workflow.kind === "offboarding";
  const desired = await desiredAccess(person);
  // Offboarding never skips an app: turned-off connections get a manual task.
  const entitled = offboarding ? await entitledAccess(person, { includeDisabled: true }) : new Map();
  const personAccounts = await q().select().from(accounts).where(eq(accounts.personId, person.id));
  const byConnection = new Map(personAccounts.map((account) => [account.connectionId, account]));
  // A replaced job that is still running may yet create an account there.
  const creating = new Set(
    (
      await q()
        .select({ connectionId: jobs.connectionId })
        .from(jobs)
        .where(
          and(eq(jobs.personId, person.id), eq(jobs.status, "running"), eq(jobs.action, "ensure_account")),
        )
    ).map((row) => row.connectionId),
  );
  const known = ["active", "unknown"];
  if (offboarding) {
    // A comparison can miss an account (a page that shifted, an answer that
    // only seemed empty); disabling one that is really gone changes nothing.
    known.push("missing");
  }
  const settings = await loadSettings();
  const planned: JobState[] = [];
  for (const connection of await provisioningConnections({ includeDisabled: offboarding })) {
    const account = byConnection.get(connection.id);
    const managed = [
      ...(await removableGroups(connection.id, person.id, await managedGroupIds(connection.id))),
    ].sort();
    const grant = desired.get(connection.id);
    let values: typeof jobs.$inferInsert;
    if (grant !== undefined) {
      values = {
        workflowId: workflow.id,
        personId: person.id,
        connectionId: connection.id,
        action: "ensure_account",
        groups: grant.groupIds,
        managedGroups: managed,
      };
    } else {
      const hasAccount = account !== undefined && known.includes(account.status);
      if (!hasAccount && !entitled.has(connection.id) && !creating.has(connection.id)) continue;
      values = {
        workflowId: workflow.id,
        personId: person.id,
        connectionId: connection.id,
        action: "disable_account",
        managedGroups: managed,
      };
      if (workflow.automatic && (await overRemovalLimit(connection, settings.removalLimitPerDay))) {
        values.status = "held";
        values.lastError = "More automatic removals than the daily limit allows; an admin must approve.";
      }
    }
    const [job] = await q().insert(jobs).values(values).returning();
    planned.push({ ...(job as Job), connection, person });
  }
  return planned;
}

async function overRemovalLimit(connection: Connection, limit: number): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await q()
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
    .where(
      and(
        eq(jobs.connectionId, connection.id),
        eq(jobs.action, "disable_account"),
        eq(workflows.automatic, true),
        gte(jobs.createdAt, since),
        notInArray(jobs.status, ["held", "cancelled"]),
      ),
    );
  return rows.length + 1 > limit;
}

/**
 * Cancels an onboarding or access update. Returns the jobs that were
 * already running: the cancel comes too late for them, and their changes go
 * ahead.
 */
export async function cancelWorkflow(
  workflowId: number,
  options: { actor: Pick<User, "id" | "email"> },
): Promise<JobState[]> {
  const [current] = await q().select().from(workflows).where(eq(workflows.id, workflowId));
  if (!current) throw new LifecycleError("This workflow does not exist.");
  if (current.kind === "offboarding") {
    throw new LifecycleError("Offboarding cannot be cancelled. Retry or complete its steps instead.");
  }
  return atomic(async () => {
    await lockPerson(current.personId);
    const [workflow] = await q().select().from(workflows).where(eq(workflows.id, workflowId)).for("update");
    if (!workflow || !(OPEN_WORKFLOW_STATUSES as readonly string[]).includes(workflow.status)) {
      throw new LifecycleError("This workflow is already finished.");
    }
    const running = await stopWorkflow(workflow, { actor: options.actor, note: "Workflow cancelled." });
    const [person] = await q().select().from(people).where(eq(people.id, workflow.personId));
    if (workflow.kind === "onboarding" && person!.status === "onboarding") {
      // Cancelled stays cancelled: the schedule waits for a new start date or
      // access profile.
      await q()
        .update(people)
        .set({ status: "planned", onboardingPaused: true })
        .where(eq(people.id, person!.id));
    }
    const summary = `Cancelled ${WORKFLOW_KIND_LABELS[workflow.kind].toLowerCase()} of ${fullName(person!)}`;
    await record("workflow.cancelled", running.length > 0 ? `${summary}. ${tooLateFor(running)}` : summary, {
      actor: options.actor,
      personId: person!.id,
      target: { type: "workflow", id: workflow.id },
    });
    return running;
  });
}

/** What a cancel means for the jobs that were already running. */
export function tooLateFor(running: { connection: { name: string } }[]): string {
  const names = [...new Set(running.map((job) => job.connection.name))].sort();
  const where = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  if (running.length === 1) {
    return `Too late for the job at ${where}: it was already running, so its change goes ahead.`;
  }
  return `Too late for the jobs at ${where}: they were already running, so their changes go ahead.`;
}

export async function archivePerson(
  personId: number,
  options: { actor: Pick<User, "id" | "email"> },
): Promise<void> {
  await atomic(async () => {
    // Serialize with workflow transitions before checking eligibility.
    const person = await lockPerson(personId);
    if (!ARCHIVABLE.includes(person.status)) {
      throw new LifecycleError("Only planned or offboarded people can be archived.");
    }
    if (await hasOpenWorkflow(person.id))
      throw new LifecycleError("Finish or cancel the open workflow first.");
    await q().update(people).set({ status: "archived" }).where(eq(people.id, person.id));
    await record("person.archived", `Archived ${fullName(person)}`, {
      actor: options.actor,
      personId: person.id,
      target: { type: "person", id: person.id },
    });
  });
}
