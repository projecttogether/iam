import { Hono } from "hono";
import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  personInputSchema,
  startWorkflowSchema,
  WORKFLOW_KINDS,
  type AccessRow,
  type PersonDetail,
  type PersonOptions,
  type PersonRow,
} from "@iam/shared/api/iam";
import { OPEN_JOB_STATUSES, WORKFLOW_KIND_LABELS } from "@iam/shared/labels";
import { today } from "../core/time";
import {
  accessProfiles,
  accounts,
  auditEvents,
  connections,
  jobs,
  people,
  tasks,
  teams,
  workflows,
  type Person,
  type User,
  type WorkflowKind,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, requireRole } from "../http/middleware";
import { AppError, notFound, validationError } from "../http/errors";
import { isOperator, record, type Operator } from "../engine/audit";
import {
  archivePerson,
  canArchive,
  canStart,
  higherRoleAppUser,
  LifecycleError,
  startWorkflow,
} from "../engine/lifecycle";
import { lockPerson } from "../engine/jobs";
import { fullName, loginName } from "../engine/people";
import { entitledAccess } from "../engine/policy";
import { defaultProfileFor } from "../engine/sync";
import { eventRows, jobRows, pageNumber, paginate, countOf, taskRows, workflowRows, iso } from "./rows";

const router = new Hono<AppEnv>();
const PER_PAGE = 50;

const like = (value: string) => `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

router.get("/people", async (c) => {
  requireRole(c, "viewer");
  const search = (c.req.query("q") ?? "").trim();
  const status = c.req.query("status") ?? "";
  const team = c.req.query("team") ?? "";
  const filters: (SQL | undefined)[] = [];
  if (search) {
    const pattern = like(search);
    filters.push(
      or(
        sql`${people.firstName} ilike ${pattern}`,
        sql`${people.lastName} ilike ${pattern}`,
        sql`${people.workEmail} ilike ${pattern}`,
        sql`${people.username} ilike ${pattern}`,
        // A full name, e.g. "Ada Lovelace".
        sql`(${people.firstName} || ' ' || ${people.lastName}) ilike ${pattern}`,
      ),
    );
  }
  if (status) filters.push(eq(people.status, status as Person["status"]));
  else if (!search) filters.push(ne(people.status, "archived"));
  if (/^[0-9]+$/.test(team)) filters.push(eq(people.teamId, Number(team)));
  const where = and(...filters);
  const total = await countOf(people, where);
  const page = await paginate<PersonRow>(
    total,
    pageNumber(c.req.query("page")),
    PER_PAGE,
    async (limit, offset) => {
      const rows = await q()
        .select({ person: people, team: teams.name, profile: accessProfiles.name })
        .from(people)
        .leftJoin(teams, eq(teams.id, people.teamId))
        .leftJoin(accessProfiles, eq(accessProfiles.id, people.accessProfileId))
        .where(where)
        .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id))
        .limit(limit)
        .offset(offset);
      return rows.map(({ person, team: teamName, profile }) => ({
        id: person.id,
        name: fullName(person),
        workEmail: person.workEmail,
        personType: person.personType,
        status: person.status,
        team: teamName,
        accessProfile: profile,
        startDate: person.startDate,
        endDate: person.endDate,
      }));
    },
  );
  return c.json(page);
});

/** The choices of the person form: teams, access profiles, and managers (everyone not archived but the person). */
router.get("/people/options", async (c) => {
  requireRole(c, "viewer");
  const except = Number(c.req.query("person") ?? 0);
  const managers = await q()
    .select()
    .from(people)
    .where(and(ne(people.status, "archived"), except > 0 ? ne(people.id, except) : undefined))
    .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id));
  const body: PersonOptions = {
    teams: (await q().select().from(teams).orderBy(asc(teams.name))).map((team) => ({
      id: team.id,
      name: team.name,
    })),
    profiles: (await q().select().from(accessProfiles).orderBy(asc(accessProfiles.name))).map((profile) => ({
      id: profile.id,
      name: profile.name,
      defaultFor: profile.defaultFor as PersonOptions["profiles"][number]["defaultFor"],
    })),
    managers: managers.map((person) => ({ id: person.id, name: fullName(person) })),
  };
  return c.json(body);
});

/** Who adds or edits a person: an app user, or the operator (`cli people`, with an admin's rights). */
type Actor = User | Operator;

export async function personOr404(id: number): Promise<Person> {
  const [person] = await q().select().from(people).where(eq(people.id, id));
  if (!person) throw notFound();
  return person;
}

router.get("/people/:id", async (c) => {
  requireRole(c, "viewer");
  const person = await personOr404(idParam(c));
  const ref = async (table: typeof teams | typeof accessProfiles, id: number | null) => {
    if (id === null) return null;
    const [row] = await q().select({ id: table.id, name: table.name }).from(table).where(eq(table.id, id));
    return row ?? null;
  };
  const manager = person.managerId === null ? null : await personOr404(person.managerId).catch(() => null);
  const [source] =
    person.sourceConnectionId === null
      ? []
      : await q().select().from(connections).where(eq(connections.id, person.sourceConnectionId));
  const personAccounts = await q().select().from(accounts).where(eq(accounts.personId, person.id));
  const byConnection = new Map(personAccounts.map((account) => [account.connectionId, account]));
  const entitled = await entitledAccess(person);
  const connectionIds = [...new Set([...entitled.keys(), ...byConnection.keys()])];
  const shown =
    connectionIds.length === 0
      ? []
      : await q()
          .select()
          .from(connections)
          .where(inArray(connections.id, connectionIds))
          .orderBy(asc(connections.name));
  const accessRows: AccessRow[] = shown.map((connection) => {
    const grant = entitled.get(connection.id);
    const account = byConnection.get(connection.id);
    return {
      connection: { id: connection.id, name: connection.name },
      grant: grant
        ? {
            groups: [...grant.groups.values()].map((group) => ({
              label: group.path || group.name,
              reasons: [...(grant.reasons.get(group.externalId) ?? [])].sort(),
            })),
          }
        : null,
      account: account
        ? {
            label: account.username || account.email || "",
            status: account.status,
            observedAt: iso(account.observedAt),
          }
        : null,
    };
  });
  const body: PersonDetail = {
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    name: fullName(person),
    workEmail: person.workEmail,
    personalEmail: person.personalEmail,
    username: person.username,
    loginName: loginName(person),
    jobTitle: person.jobTitle,
    personType: person.personType,
    status: person.status,
    team: await ref(teams, person.teamId),
    manager: manager ? { id: manager.id, name: fullName(manager) } : null,
    accessProfile: await ref(accessProfiles, person.accessProfileId),
    startDate: person.startDate,
    endDate: person.endDate,
    source: source ? { connection: source.name, id: person.sourceId } : null,
    notes: person.notes,
    onboardingPaused: person.onboardingPaused,
    today: today(),
    accessRows,
    workflows: await workflowRows(eq(workflows.personId, person.id), 20),
    openJobs: await jobRows(and(eq(jobs.personId, person.id), inArray(jobs.status, [...OPEN_JOB_STATUSES]))),
    tasks: await taskRows(eq(tasks.personId, person.id), 20),
    events: await eventRows(eq(auditEvents.personId, person.id), 30),
    can: {
      onboard: canStart(person, "onboarding"),
      update: canStart(person, "access_update"),
      offboard: canStart(person, "offboarding"),
      archive: await canArchive(person),
    },
  };
  return c.json(body);
});

export type Values = Omit<typeof people.$inferInsert, "id">;

/** Validates the form as Django's PersonForm did, beyond the schema: choices that exist, a unique work email. */
export async function cleanPerson(
  input: ReturnType<typeof personInputSchema.parse>,
  personId: number | null,
): Promise<Values> {
  const errors: Record<string, string> = {};
  const workEmail = input.workEmail ? input.workEmail.toLowerCase() : null;
  if (workEmail) {
    const taken = await q()
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.workEmail, workEmail), personId ? ne(people.id, personId) : undefined))
      .limit(1);
    if (taken.length > 0) errors.workEmail = "Person with this Work email already exists.";
  }
  const exists = async (table: typeof teams | typeof accessProfiles | typeof people, id: number | null) => {
    if (id === null) return true;
    const [row] = await q().select({ id: table.id }).from(table).where(eq(table.id, id));
    return Boolean(row);
  };
  const invalidChoice = "Select a valid choice. That choice is not one of the available choices.";
  if (!(await exists(teams, input.teamId))) errors.teamId = invalidChoice;
  if (!(await exists(accessProfiles, input.accessProfileId))) errors.accessProfileId = invalidChoice;
  if (input.managerId !== null) {
    const [manager] = await q().select().from(people).where(eq(people.id, input.managerId));
    if (!manager || manager.status === "archived" || manager.id === personId)
      errors.managerId = invalidChoice;
  }
  if (Object.keys(errors).length > 0) throw validationError(errors);
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    workEmail,
    personalEmail: input.personalEmail,
    username: input.username,
    jobTitle: input.jobTitle,
    personType: input.personType,
    teamId: input.teamId,
    managerId: input.managerId,
    // Empty: the profile that is the default for the person type.
    accessProfileId: input.accessProfileId ?? (await defaultProfileFor(input.personType)),
    startDate: input.startDate,
    endDate: input.endDate,
    notes: input.notes,
  };
}

const FIELD_NAMES: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  workEmail: "work_email",
  personalEmail: "personal_email",
  username: "username",
  jobTitle: "job_title",
  personType: "person_type",
  teamId: "team",
  managerId: "manager",
  accessProfileId: "access_profile",
  startDate: "start_date",
  endDate: "end_date",
  notes: "notes",
};

/** Adds a person from the checked values of the form, and audits it. */
export async function addPerson(values: Values, actor: Actor): Promise<Person> {
  return atomic(async () => {
    const [created] = await q().insert(people).values(values).returning();
    await record("person.created", `Added ${fullName(created!)}`, {
      actor,
      personId: created!.id,
      target: { type: "person", id: created!.id },
    });
    return created!;
  });
}

router.post("/people", async (c) => {
  const user = requireRole(c, "approver");
  const values = await cleanPerson(await jsonBody(c, personInputSchema), null);
  const person = await addPerson(values, user);
  return c.json({ id: person.id, message: `Added ${fullName(person)}.` }, 201);
});

/**
 * Saves the edit form of an existing person and audits it. Returns the
 * page's message, and whether access changed (an access update applies it).
 */
export async function updatePerson(
  id: number,
  input: ReturnType<typeof personInputSchema.parse>,
  actor: Actor,
): Promise<{ message: string; info: boolean }> {
  const result = await atomic(async () => {
    // The form saves the whole row: the lock keeps it from writing back a
    // status a workflow changed meanwhile.
    const person = await lockPerson(id);
    const values = await cleanPerson(input, id);
    // As Django's changed_data: the profile counts as changed when the choice
    // submitted differs from the saved one, before an empty choice becomes the default.
    const submitted: Values = { ...values, accessProfileId: input.accessProfileId };
    const changed = Object.keys(FIELD_NAMES).filter(
      (key) => (person[key as keyof Person] ?? null) !== (submitted[key as keyof Values] ?? null),
    );
    // Changing the last day can cause the worker to turn off the linked app user.
    // The operator has an admin's rights, and no app user has a higher role.
    if (changed.includes("endDate") && !isOperator(actor) && (await higherRoleAppUser(person, actor))) {
      throw validationError({ endDate: "Only an admin can change this person's last day." });
    }
    const update: Partial<Person> = { ...values };
    if (changed.includes("startDate") || changed.includes("accessProfileId")) update.onboardingPaused = false;
    await q().update(people).set(update).where(eq(people.id, id));
    const saved = { ...person, ...update };
    await record("person.updated", `Edited ${fullName(saved)}`, {
      actor,
      personId: id,
      target: { type: "person", id },
      details: { fields: changed.map((key) => FIELD_NAMES[key]!).sort() },
    });
    return { saved, changed };
  });
  const messages: string[] = [];
  const accessChanged = result.changed.includes("accessProfileId") || result.changed.includes("teamId");
  if (accessChanged && (result.saved.status === "active" || result.saved.status === "onboarding")) {
    messages.push("Access changed. Start an access update to apply it in the connected apps.");
  }
  messages.push(`Saved ${fullName(result.saved)}.`);
  return { message: messages.join(" "), info: accessChanged };
}

router.put("/people/:id", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  await personOr404(id);
  const input = await jsonBody(c, personInputSchema);
  return c.json({ id, ...(await updatePerson(id, input, user)) });
});

router.post("/people/:id/start/:kind", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  await personOr404(id);
  const kind = c.req.param("kind") as WorkflowKind;
  if (!WORKFLOW_KINDS.includes(kind)) throw notFound();
  const { reason } = await jsonBody(c, startWorkflowSchema);
  try {
    const workflow = await startWorkflow(id, kind, { actor: user, reason: (reason ?? "").trim() });
    return c.json({
      id: workflow.id,
      message: `Started ${WORKFLOW_KIND_LABELS[workflow.kind].toLowerCase()}.`,
    });
  } catch (error) {
    if (error instanceof LifecycleError) throw new AppError(409, "lifecycle", error.message);
    throw error;
  }
});

router.post("/people/:id/archive", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  const person = await personOr404(id);
  try {
    await archivePerson(id, { actor: user });
  } catch (error) {
    if (error instanceof LifecycleError) throw new AppError(409, "lifecycle", error.message);
    throw error;
  }
  return c.json({ id, message: `Archived ${fullName(person)}.` });
});

export default router;
