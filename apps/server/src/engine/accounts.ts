import { and, asc, eq, ne, notInArray, or, sql } from "drizzle-orm";
import type { DisableResult, EnsureResult, ExternalAccount } from "../adapters/base";
import {
  accounts,
  people,
  providerGroups,
  type Account,
  type Connection,
  type Job,
  type Person,
} from "../db/schema";
import { atomic, isUniqueViolation, q } from "../db/tx";
import { fullName } from "./people";

/**
 * Accounts: what this app knows about an account in a connected app.
 *
 * The only module that writes Account rows. Jobs record what a change did,
 * completed manual tasks record what a person did by hand, and account
 * comparisons record what the app listed. The same rules apply to all three:
 *
 * - An account linked to one person is never linked to, or changed for,
 *   another person.
 * - A row keeps what the app reported, each value up to 255 characters, and
 *   its old value where the app reports none.
 * - The applied-groups ledger lists the groups this app put the account in.
 *   They stay removable after a profile or team stops using them. A row
 *   without an ID stands for the same account (a manual change recorded it),
 *   so its ledger carries over to the listed account that replaces it.
 */

/** The account is linked to someone else; the message says to whom. */
export class AccountConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountConflict";
  }
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The person other than this one that the app's account is linked to. */
export async function otherOwner(
  connectionId: number,
  externalId: string,
  personId: number,
): Promise<Person | null> {
  const [row] = await q()
    .select({ person: people })
    .from(accounts)
    .innerJoin(people, eq(people.id, accounts.personId))
    .where(
      and(
        eq(accounts.connectionId, connectionId),
        eq(accounts.externalId, externalId),
        ne(accounts.personId, personId),
      ),
    )
    .orderBy(asc(accounts.id))
    .limit(1);
  return row?.person ?? null;
}

/**
 * The groups a change may remove from the person's account: the managed
 * groups, plus the groups this app has put the account in. Jobs for the
 * same person and app run one after another, so this includes what a job
 * that was still running at planning time applied. Groups marked missing
 * are left alone: an import that read nothing marks every group missing.
 */
export async function removableGroups(
  connectionId: number,
  personId: number,
  managed: Iterable<string>,
): Promise<Set<string>> {
  const [account] = await q()
    .select({ appliedGroups: accounts.appliedGroups })
    .from(accounts)
    .where(and(eq(accounts.connectionId, connectionId), eq(accounts.personId, personId)))
    .limit(1);
  const missing = await missingGroups(connectionId);
  const result = new Set<string>([...managed, ...(account?.appliedGroups ?? [])]);
  for (const group of missing) result.delete(group);
  return result;
}

/** Groups the app no longer lists. Their memberships stay as they are until an import sees them again. */
export async function missingGroups(connectionId: number): Promise<Set<string>> {
  const rows = await q()
    .select({ externalId: providerGroups.externalId })
    .from(providerGroups)
    .where(and(eq(providerGroups.connectionId, connectionId), eq(providerGroups.missing, true)));
  return new Set(rows.map((row) => row.externalId));
}

type JobContext = Pick<Job, "connectionId" | "personId" | "groups" | "action"> & {
  connection: Pick<Connection, "id" | "name">;
  person: Pick<Person, "id" | "firstName" | "lastName">;
};

/**
 * Records what a job did to the person's account. Throws AccountConflict
 * when the app's account is linked to someone else.
 */
export async function recordJobResult(job: JobContext, result: EnsureResult | DisableResult): Promise<void> {
  const external = result.account;
  // Lock the rows this may change in primary-key order, as a comparison
  // locks a connection's accounts: in one order, the two never deadlock.
  const rowFilter =
    external !== null && external.externalId
      ? or(eq(accounts.personId, job.personId), eq(accounts.externalId, external.externalId))
      : eq(accounts.personId, job.personId);
  const locked = await q()
    .select()
    .from(accounts)
    .where(and(rowFilter, eq(accounts.connectionId, job.connectionId)))
    .orderBy(asc(accounts.id))
    .for("update", { of: accounts });
  let existing = locked.find((account) => account.personId === job.personId) ?? null;
  if (external === null) {
    if (existing !== null) {
      await q()
        .update(accounts)
        .set({ status: "missing", appliedGroups: [], observedAt: new Date() })
        .where(eq(accounts.id, existing.id));
    }
    return;
  }
  let pendingDelete: Account | null = null;
  let carried: Pick<Account, "appliedGroups" | "createdByApp"> | null = null;
  if (external.externalId) {
    const other =
      locked.find((account) => account.externalId === external.externalId && account !== existing) ?? null;
    if (other !== null) {
      if (other.personId !== null && other.personId !== job.personId) {
        const owner = await personById(other.personId);
        throw new AccountConflict(
          `The ${job.connection.name} account ${external.username || external.externalId} ` +
            `is linked to ${owner ? fullName(owner) : "someone else"}. Check the work email and username.`,
        );
      }
      if (existing !== null) {
        pendingDelete = existing;
        if (!existing.externalId) carried = existing;
      }
      existing = other;
    }
  }
  const account: Partial<Account> = existing
    ? { ...existing }
    : { connectionId: job.connectionId, appliedGroups: [], createdByApp: false };
  if (carried) {
    account.appliedGroups = sorted([...(account.appliedGroups ?? []), ...carried.appliedGroups]);
    account.createdByApp = Boolean(account.createdByApp || carried.createdByApp);
  }
  account.personId = job.personId;
  observe(account, external);
  if (result.kind === "ensure") {
    account.createdByApp = Boolean(account.createdByApp || result.created);
    if (result.groupError === null) {
      // Missing groups were left alone, so they stay in the ledger.
      const missing = await missingGroups(job.connectionId);
      const kept = (account.appliedGroups ?? []).filter((group) => missing.has(group));
      account.appliedGroups = sorted([...job.groups, ...kept]);
    } else {
      // Unfinished: keep every group the app may have to remove later.
      const removed = new Set(result.groupsRemoved);
      account.appliedGroups = sorted(
        [...(account.appliedGroups ?? []), ...job.groups].filter((group) => !removed.has(group)),
      );
    }
  } else {
    const removed = new Set(result.groupsRemoved);
    account.appliedGroups = (account.appliedGroups ?? []).filter((group) => !removed.has(group));
  }
  try {
    await atomic(async () => {
      if (pendingDelete !== null) await q().delete(accounts).where(eq(accounts.id, pendingDelete.id));
      await saveAccount(account);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AccountConflict(
        `The ${job.connection.name} account could not be linked to ${fullName(job.person)}.`,
      );
    }
    throw error;
  }
}

/**
 * Records a change a person made by hand. Without the app's ID, the row
 * stands for the account until a comparison finds it.
 */
export async function recordManualChange(
  job: Pick<Job, "connectionId" | "personId" | "action" | "groups">,
): Promise<void> {
  const ensuring = job.action === "ensure_account";
  const values: Partial<Account> = {
    status: ensuring ? "active" : "disabled",
    appliedGroups: ensuring ? sorted(job.groups) : [],
    observedAt: new Date(),
  };
  if (ensuring) values.observedGroups = sorted(job.groups);
  // Locked: a comparison may be replacing this row with the account it listed.
  // Then the row is gone once the lock is free, and the insert finds the
  // listed account in its place: the change is recorded there.
  const current = () =>
    q()
      .select()
      .from(accounts)
      .where(and(eq(accounts.connectionId, job.connectionId), eq(accounts.personId, job.personId)))
      .limit(1)
      .for("update", { of: accounts });
  let [existing] = await current();
  if (!existing) {
    const inserted = await q().execute(sql`
      insert into ${accounts} (connection_id, person_id, external_id, username, email, display_name, status,
        observed_groups, applied_groups, observed_at, created_by_app, updated_at)
      values (${job.connectionId}, ${job.personId}, '', '', '', '', ${values.status},
        ${values.observedGroups ? JSON.stringify(values.observedGroups) : null}::jsonb,
        ${JSON.stringify(values.appliedGroups)}::jsonb, now(), false, now())
      on conflict (connection_id, person_id) where person_id is not null do nothing
      returning id
    `);
    if (inserted.rows.length > 0) return;
    [existing] = await current();
  }
  await q().update(accounts).set(values).where(eq(accounts.id, existing!.id));
}

export type ListingSummary = { accounts: number; new_links: number; missing: number };

/**
 * Records an account comparison: updates the accounts the app lists, links
 * an unlinked one to a person on a unique match, and marks the accounts it
 * no longer lists as missing.
 */
export async function recordListing(
  connection: Pick<Connection, "id">,
  listed: ExternalAccount[],
): Promise<ListingSummary> {
  const now = new Date();
  const seen = new Set<string>();
  let newLinks = 0;
  let missing = 0;
  await atomic(async () => {
    // Locked: the rows are saved whole, and a job may record its account (and
    // the groups it applied) meanwhile. Every row, placeholders too, in
    // primary-key order, as a job locks the rows it changes.
    const locked = await q()
      .select()
      .from(accounts)
      .where(eq(accounts.connectionId, connection.id))
      .orderBy(asc(accounts.id))
      .for("update", { of: accounts });
    const byId = new Map(
      locked.filter((account) => account.externalId).map((account) => [account.externalId, account]),
    );
    for (const external of listed) {
      // A listing paged by offset can list an account twice.
      if (!external.externalId || seen.has(external.externalId)) continue;
      seen.add(external.externalId);
      const account: Partial<Account> = byId.get(external.externalId)
        ? { ...byId.get(external.externalId)! }
        : {
            connectionId: connection.id,
            externalId: external.externalId,
            appliedGroups: [],
            createdByApp: false,
          };
      observe(account, external, now);
      if (account.personId === null || account.personId === undefined) {
        const person = await accountSeams.matchPerson(connection.id, external);
        if (person !== null) {
          // Read again: a completed manual task may have added the person's
          // placeholder since the rows were locked.
          const [placeholder] = await q()
            .select()
            .from(accounts)
            .where(
              and(
                eq(accounts.connectionId, connection.id),
                eq(accounts.personId, person.id),
                eq(accounts.externalId, ""),
              ),
            )
            .limit(1)
            .for("update", { of: accounts });
          if (placeholder) {
            account.appliedGroups = sorted([...(account.appliedGroups ?? []), ...placeholder.appliedGroups]);
            account.createdByApp = Boolean(account.createdByApp || placeholder.createdByApp);
            await q().delete(accounts).where(eq(accounts.id, placeholder.id));
          }
          account.personId = person.id;
          newLinks += 1;
        }
      }
      await saveAccount(account);
    }
    const gone = await q()
      .update(accounts)
      .set({ status: "missing", observedAt: now })
      .where(
        and(
          eq(accounts.connectionId, connection.id),
          ne(accounts.externalId, ""),
          seen.size > 0 ? notInArray(accounts.externalId, [...seen]) : undefined,
          ne(accounts.status, "missing"),
        ),
      )
      .returning({ id: accounts.id });
    missing = gone.length;
  });
  return { accounts: seen.size, new_links: newLinks, missing };
}

/** Copies what the app reported into the row; values it does not report keep their old value. */
function observe(account: Partial<Account>, external: ExternalAccount, now: Date = new Date()): void {
  account.externalId = external.externalId || account.externalId || "";
  account.username = (external.username || account.username || "").slice(0, 255);
  account.email = (external.email || account.email || "").slice(0, 255);
  account.displayName = (external.displayName || account.displayName || "").slice(0, 255);
  account.status = external.active ? "active" : "disabled";
  if (external.groups !== null) account.observedGroups = sorted(external.groups);
  account.observedAt = now;
}

async function saveAccount(account: Partial<Account>): Promise<void> {
  const values = {
    externalId: account.externalId ?? "",
    username: account.username ?? "",
    email: account.email ?? "",
    displayName: account.displayName ?? "",
    status: account.status ?? "unknown",
    observedGroups: account.observedGroups ?? null,
    appliedGroups: account.appliedGroups ?? [],
    observedAt: account.observedAt ?? null,
    createdByApp: account.createdByApp ?? false,
    connectionId: account.connectionId!,
    personId: account.personId ?? null,
  };
  if (account.id !== undefined) {
    await q().update(accounts).set(values).where(eq(accounts.id, account.id));
  } else {
    await q().insert(accounts).values(values);
  }
}

async function personById(id: number): Promise<Person | null> {
  const [person] = await q().select().from(people).where(eq(people.id, id));
  return person ?? null;
}

const iexact = (column: typeof people.workEmail | typeof people.username, value: string) =>
  sql`lower(${column}) = lower(${value})`;

async function matchPerson(connectionId: number, external: ExternalAccount): Promise<Person | null> {
  const filters = [];
  if (external.email) filters.push(iexact(people.workEmail, external.email));
  if (external.username) {
    filters.push(iexact(people.username, external.username));
    if (external.username.includes("@")) filters.push(iexact(people.workEmail, external.username));
  }
  if (filters.length === 0) return null;
  const candidates = await q()
    .select()
    .from(people)
    .where(or(...filters))
    .orderBy(asc(people.lastName), asc(people.firstName))
    .limit(2);
  if (candidates.length !== 1) return null;
  const person = candidates[0]!;
  const email = external.email.trim().toLowerCase();
  if (email && person.workEmail && email !== person.workEmail.trim().toLowerCase()) {
    // Matched by username alone: as for a job, an email that is not the
    // person's shows that the username belongs to someone else.
    return null;
  }
  const linked = await q()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.connectionId, connectionId),
        eq(accounts.personId, person.id),
        ne(accounts.externalId, ""),
      ),
    )
    .limit(1);
  return linked.length > 0 ? null : person;
}

/** Tests only: recordListing matches people through this object, so a test can hold a comparison midway. */
export const accountSeams = { matchPerson };
