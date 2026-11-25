import { and, asc, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import { PERSON_TYPE_LABELS, SYNC_KIND_LABELS, SYNC_STATUS_LABELS } from "@iam/shared/labels";
import { AdapterError, AdapterKind, type Adapter, type HRRecord } from "../adapters/base";
import { SecretUnreadable } from "../core/crypto";
import { today } from "../core/time";
import {
  accessProfiles,
  accounts,
  connections,
  people,
  providerGroups,
  syncRuns,
  teams,
  type Connection,
  type Person,
  type SyncKind,
  type SyncRun,
  type User,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import { logger } from "../logger";
import { recordListing } from "./accounts";
import { record } from "./audit";
import { adapterClassOf, buildAdapter, kindOf } from "./connections";
import { fullName } from "./people";
import { desiredAccess } from "./policy";

/**
 * Reads from connections: group import, account comparison and people
 * import.
 *
 * None of these change anything in a connected app. The account comparison
 * records what the app lists (src/engine/accounts.ts links accounts to
 * people) and reports drift; fixing drift is a workflow an approver starts.
 * The people import creates and updates people but never offboards anyone by
 * itself: an end date does that through the schedule.
 */

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

type Actor = Pick<User, "id" | "email"> | null;

async function run(
  connection: Connection,
  kind: SyncKind,
  actor: Actor,
  body: (adapter: Adapter) => Promise<Record<string, unknown>>,
): Promise<SyncRun> {
  const [created] = await q()
    .insert(syncRuns)
    .values({ connectionId: connection.id, kind, triggeredById: actor?.id ?? null })
    .returning();
  let status: SyncRun["status"];
  let summary: Record<string, unknown> = {};
  let error = "";
  try {
    const adapter = buildAdapter(connection);
    summary = await body(adapter);
    status = "succeeded";
  } catch (exception) {
    status = "failed";
    if (
      exception instanceof AdapterError ||
      exception instanceof SecretUnreadable ||
      exception instanceof SyncError
    ) {
      error = exception.message.slice(0, 2000);
    } else {
      // A failed read is reported, not thrown.
      logger.error({ err: exception, connectionId: connection.id, kind }, "a read from a connection failed");
      error = `Unexpected error (${exception instanceof Error ? exception.constructor.name : typeof exception}). The details are in the log.`;
    }
  }
  const finishedAt = new Date();
  const [saved] = await q()
    .update(syncRuns)
    .set({ status, summary, error, finishedAt })
    .where(eq(syncRuns.id, created!.id))
    .returning();
  await q().update(connections).set({ lastSyncAt: finishedAt }).where(eq(connections.id, connection.id));
  await record(
    `sync.${kind}`,
    `${SYNC_KIND_LABELS[kind]} from ${connection.name}: ${SYNC_STATUS_LABELS[status].toLowerCase()}`,
    { actor, target: { type: "syncrun", id: created!.id }, details: error ? { error } : {} },
  );
  return saved!;
}

/**
 * Closes scheduled reads whose worker stopped midway (a crash, the watchdog)
 * as failed, and starts their connection's pause after a failure now: a read
 * that keeps stopping its worker then waits its turn instead of coming first
 * again and holding up every other read. Only call it while holding the read
 * lock (src/engine/schedule.ts runDueSync), when no scheduled read runs.
 */
export async function recoverStoppedReads(): Promise<number> {
  const now = new Date();
  const stopped = await q()
    .select({ run: syncRuns, connectionName: connections.name })
    .from(syncRuns)
    .innerJoin(connections, eq(connections.id, syncRuns.connectionId))
    .where(and(eq(syncRuns.status, "running"), isNull(syncRuns.triggeredById)))
    .orderBy(asc(syncRuns.startedAt), asc(syncRuns.id));
  let count = 0;
  for (const { run: stoppedRun, connectionName } of stopped) {
    await atomic(async () => {
      const error = "The worker stopped during this read.";
      await q()
        .update(syncRuns)
        .set({ status: "failed", error, finishedAt: now })
        .where(eq(syncRuns.id, stoppedRun.id));
      await q()
        .update(connections)
        .set({ lastSyncAt: now })
        .where(eq(connections.id, stoppedRun.connectionId));
      await record(
        `sync.${stoppedRun.kind}`,
        `${SYNC_KIND_LABELS[stoppedRun.kind]} from ${connectionName}: failed`,
        {
          target: { type: "syncrun", id: stoppedRun.id },
          details: { error },
        },
      );
    });
    count += 1;
  }
  return count;
}

// -- groups ------------------------------------------------------------------------

export async function importGroups(connection: Connection, actor: Actor = null): Promise<SyncRun> {
  return run(connection, "groups", actor, async (adapter) => {
    if (!adapter.supportsGroups) throw new SyncError(`${connection.name} has no groups to import.`);
    const groups = await adapter.listGroups();
    const now = new Date();
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    let gone = 0;
    await atomic(async () => {
      for (const group of groups) {
        seen.add(group.externalId);
        const values = {
          name: group.name.slice(0, 255),
          path: group.path.slice(0, 500),
          description: group.description,
          missing: false,
          manual: false,
          seenAt: now,
        };
        // One statement, so an import running at the same time cannot make it collide.
        const [row] = await q()
          .insert(providerGroups)
          .values({ ...values, connectionId: connection.id, externalId: group.externalId })
          .onConflictDoUpdate({
            target: [providerGroups.connectionId, providerGroups.externalId],
            set: values,
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        if (row!.inserted) created += 1;
        else updated += 1;
      }
      const missing = await q()
        .update(providerGroups)
        .set({ missing: true })
        .where(
          and(
            eq(providerGroups.connectionId, connection.id),
            eq(providerGroups.manual, false),
            eq(providerGroups.missing, false),
            seen.size > 0 ? notInArray(providerGroups.externalId, [...seen]) : undefined,
          ),
        )
        .returning({ id: providerGroups.id });
      gone = missing.length;
      await q().update(connections).set({ groupsSyncedAt: now }).where(eq(connections.id, connection.id));
    });
    return { groups: seen.size, created, updated, missing: gone };
  });
}

// -- accounts ------------------------------------------------------------------------

export function canCompareAccounts(connection: Connection): boolean {
  const cls = adapterClassOf(connection);
  if (cls === null || cls.kind !== AdapterKind.PROVISIONING || !cls.supportsAccountListing) return false;
  let adapter: Adapter;
  try {
    adapter = buildAdapter(connection);
  } catch {
    return false;
  }
  try {
    return adapter.canReadAccounts();
  } catch {
    return false;
  }
}

/**
 * A scheduled comparison that would mark at least this many accounts, and
 * more than half of those the app saw, as not found records nothing.
 */
export const VANISHED_LIMIT = 10;

export async function compareAccounts(connection: Connection, actor: Actor = null): Promise<SyncRun> {
  return run(connection, "accounts", actor, async (adapter) => {
    if (!canCompareAccounts(connection)) throw new SyncError(`${connection.name} cannot list accounts.`);
    const listed = await adapter.listAccounts();
    if (actor === null) await checkListing(connection, listed);
    return { ...(await recordListing(connection, listed)), ...(await drift(connection)) };
  });
}

/**
 * Refuses a listing that lacks most of the accounts the app saw: such an
 * answer (an empty page, a permission that changed) is more likely broken
 * than true. A comparison an admin starts records it anyway.
 */
async function checkListing(connection: Connection, listed: { externalId: string }[]): Promise<void> {
  const seen = new Set(listed.map((account) => account.externalId));
  const rows = await q()
    .select({ externalId: accounts.externalId })
    .from(accounts)
    .where(
      and(
        eq(accounts.connectionId, connection.id),
        ne(accounts.externalId, ""),
        ne(accounts.status, "missing"),
      ),
    );
  const known = new Set(rows.map((row) => row.externalId));
  const vanished = [...known].filter((id) => !seen.has(id)).length;
  if (vanished >= VANISHED_LIMIT && vanished * 2 > known.size) {
    throw new SyncError(
      `${connection.name} listed ${seen.size} accounts, without ${vanished} of the ` +
        `${known.size} it listed before. Nothing was recorded: an answer like this is more ` +
        "likely broken than true. If the accounts are really gone, use Compare accounts now.",
    );
  }
}

/** Differences between desired access and the accounts last seen. */
export async function drift(connection: Connection): Promise<Record<string, unknown>> {
  const linked = await q()
    .select()
    .from(accounts)
    .where(and(eq(accounts.connectionId, connection.id), sql`${accounts.personId} is not null`))
    .orderBy(asc(accounts.id));
  const byPerson = new Map(linked.map((account) => [account.personId!, account]));
  const missingAccess: { id: number; name: string }[] = [];
  const unexpectedAccess: { id: number; name: string; status: string }[] = [];
  const everyone = await q()
    .select()
    .from(people)
    .where(ne(people.status, "archived"))
    .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id));
  for (const person of everyone) {
    const shouldHave = (await desiredAccess(person)).has(connection.id);
    const account = byPerson.get(person.id);
    const active = account !== undefined && account.status === "active";
    if (shouldHave && !active && person.status === "active") {
      missingAccess.push({ id: person.id, name: fullName(person) });
    }
    // Planned people keep what a cancelled onboarding created.
    if (active && !shouldHave && ["planned", "offboarded", "active"].includes(person.status)) {
      unexpectedAccess.push({ id: person.id, name: fullName(person), status: person.status });
    }
  }
  const [unlinked] = await q()
    .select({ count: sql<number>`count(*)` })
    .from(accounts)
    .where(
      and(eq(accounts.connectionId, connection.id), isNull(accounts.personId), eq(accounts.status, "active")),
    );
  return {
    missing_access: missingAccess,
    unexpected_access: unexpectedAccess,
    unlinked_active: Number(unlinked?.count ?? 0),
  };
}

// -- people ----------------------------------------------------------------------------

type PeopleSummary = {
  records: number;
  created: { id: number; name: string }[];
  updated: { id: number; name: string; fields: string[] }[];
  work_email_differs: Record<string, unknown>[];
  inactive_without_end_date: { id: number; name: string }[];
  not_listed: { id: number; name: string }[];
  skipped?: { source_id: string; reason: string }[];
};

export async function importPeople(connection: Connection, actor: Actor = null): Promise<SyncRun> {
  return run(connection, "people", actor, async (adapter) => {
    if (kindOf(connection) !== AdapterKind.HR_SOURCE)
      throw new SyncError(`${connection.name} does not import people.`);
    const records = await adapter.listPeople();
    const summary: PeopleSummary = {
      records: records.length,
      created: [],
      updated: [],
      work_email_differs: [],
      inactive_without_end_date: [],
      not_listed: [],
    };
    const listedIds = new Set<string>();
    for (const item of records) {
      listedIds.add(item.externalId);
      await atomic(() => importRecord(connection, item, summary, actor));
    }
    const notListed = await q()
      .select()
      .from(people)
      .where(
        and(
          eq(people.sourceConnectionId, connection.id),
          listedIds.size > 0 ? notInArray(people.sourceId, [...listedIds]) : undefined,
          notInArray(people.status, ["offboarded", "archived"]),
        ),
      )
      .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id))
      .limit(100);
    summary.not_listed = notListed.map((person) => ({ id: person.id, name: fullName(person) }));
    summary.skipped = (adapter.skipped ?? [])
      .slice(0, 100)
      .map(([sourceId, reason]) => ({ source_id: sourceId, reason }));
    return summary;
  });
}

const IMPORTED_FIELDS = [
  "firstName",
  "lastName",
  "personalEmail",
  "jobTitle",
  "personType",
  "startDate",
  "endDate",
] as const;
const FIELD_NAMES: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  personalEmail: "personal_email",
  jobTitle: "job_title",
  personType: "person_type",
  startDate: "start_date",
  endDate: "end_date",
};

const iexact = (column: typeof people.workEmail | typeof teams.name, value: string) =>
  sql`lower(${column}) = lower(${value})`;

/** Imports one HR record; importPeople runs each in its own transaction (exported for tests). */
export async function importRecord(
  connection: Connection,
  item: HRRecord,
  summary: PeopleSummary,
  actor: Actor,
): Promise<void> {
  // Locked: the import saves the whole row, which must not write back a status
  // a workflow changed meanwhile.
  let [person] = await q()
    .select()
    .from(people)
    .where(and(eq(people.sourceConnectionId, connection.id), eq(people.sourceId, item.externalId)))
    .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id))
    .limit(1)
    .for("no key update");
  const email = (item.workEmail || "").trim().toLowerCase();
  if (person === undefined && email) {
    [person] = await q()
      .select()
      .from(people)
      .where(and(iexact(people.workEmail, email), eq(people.sourceId, "")))
      .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id))
      .limit(1)
      .for("no key update");
  }
  const values = {
    firstName: item.firstName.trim().slice(0, 150),
    lastName: item.lastName.trim().slice(0, 150),
    personalEmail: (item.personalEmail || "").trim().slice(0, 254),
    jobTitle: (item.jobTitle || "").slice(0, 200),
    personType: (item.personType in PERSON_TYPE_LABELS
      ? item.personType
      : "employee") as Person["personType"],
    startDate: item.startDate,
    endDate: item.endDate,
  };
  const [team] = item.team
    ? await q().select().from(teams).where(iexact(teams.name, item.team)).orderBy(asc(teams.name)).limit(1)
    : [];
  const [manager] = item.managerEmail
    ? await q()
        .select()
        .from(people)
        .where(iexact(people.workEmail, item.managerEmail))
        .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id))
        .limit(1)
    : [];
  if (person === undefined) {
    if (!item.active || (item.endDate && item.endDate < today())) return;
    if (email) {
      const taken = await q()
        .select({ id: people.id })
        .from(people)
        .where(iexact(people.workEmail, email))
        .limit(1);
      if (taken.length > 0) {
        summary.work_email_differs.push({ source_id: item.externalId, email });
        return;
      }
    }
    const profile = await defaultProfileFor(values.personType);
    const [created] = await q()
      .insert(people)
      .values({
        ...values,
        workEmail: email || null,
        teamId: team?.id ?? null,
        managerId: manager?.id ?? null,
        accessProfileId: profile,
        sourceConnectionId: connection.id,
        sourceId: item.externalId,
      })
      .returning();
    summary.created.push({ id: created!.id, name: fullName(created!) });
    await record("person.imported", `Imported ${fullName(created!)} from ${connection.name}`, {
      actor,
      personId: created!.id,
      target: { type: "person", id: created!.id },
    });
    return;
  }
  const changed: Record<string, [string, string]> = {};
  const update: Partial<Person> = {};
  for (const name of IMPORTED_FIELDS) {
    const before = person[name] ?? null;
    const after = values[name] ?? null;
    if (before !== after && !(name === "personalEmail" && !after)) {
      changed[FIELD_NAMES[name]!] = [String(before ?? ""), String(after ?? "")];
      Object.assign(update, { [name]: after });
    }
  }
  if (team !== undefined && person.teamId !== team.id) {
    changed.team = [await teamName(person.teamId), team.name];
    update.teamId = team.id;
  }
  if (manager !== undefined && manager.id !== person.id && person.managerId !== manager.id) {
    changed.manager = [await personName(person.managerId), fullName(manager)];
    update.managerId = manager.id;
  }
  if (!person.sourceId) {
    update.sourceConnectionId = connection.id;
    update.sourceId = item.externalId;
    changed.source = ["", connection.name];
  }
  if (email && !person.workEmail) {
    update.workEmail = email;
    changed.work_email = ["", email];
  } else if (email && person.workEmail && person.workEmail.toLowerCase() !== email) {
    summary.work_email_differs.push({ id: person.id, name: fullName(person), email });
  }
  if (!item.active && !item.endDate) {
    summary.inactive_without_end_date.push({ id: person.id, name: fullName(person) });
  }
  if ("start_date" in changed) update.onboardingPaused = false;
  if (Object.keys(changed).length > 0) {
    await q().update(people).set(update).where(eq(people.id, person.id));
    const saved = { ...person, ...update };
    summary.updated.push({ id: person.id, name: fullName(saved), fields: Object.keys(changed).sort() });
    await record("person.updated", `Updated ${fullName(saved)} from ${connection.name}`, {
      actor,
      personId: person.id,
      target: { type: "person", id: person.id },
      details: { changes: changed },
    });
  }
}

/** The access profile that is the default for a person type, if any. */
export async function defaultProfileFor(personType: string): Promise<number | null> {
  const profiles = await q().select().from(accessProfiles).orderBy(asc(accessProfiles.name));
  return profiles.find((profile) => (profile.defaultFor ?? []).includes(personType))?.id ?? null;
}

async function teamName(id: number | null): Promise<string> {
  if (id === null) return "";
  const [row] = await q().select({ name: teams.name }).from(teams).where(eq(teams.id, id));
  return row?.name ?? "";
}

async function personName(id: number | null): Promise<string> {
  if (id === null) return "";
  const [row] = await q().select().from(people).where(eq(people.id, id));
  return row ? fullName(row) : "";
}
