import { and, eq, isNull, or, sql } from "drizzle-orm";
import { ROLE_LABELS } from "@iam/shared/labels";
import { config } from "../config";
import { sessions, users, type Role, type User } from "../db/schema";
import { atomic, isUniqueViolation, q } from "../db/tx";
import { record } from "../engine/audit";

/**
 * Who signs in. The provider proves who someone is; the app's own user
 * records decide what they may do. A sign-in succeeds only for an active app
 * user, found by the provider's subject or, for a user an admin added by
 * email, by a verified email address (the subject is then bound). A user can
 * also get a role from the provider's group claim (OIDC_*_GROUPS) or, while
 * no admin exists, from BOOTSTRAP_ADMIN_EMAILS.
 */

export type Claims = Record<string, unknown>;

/** The sign-in cannot go on: the person is not let in. The message stays in the log. */
export class SignInRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRefused";
  }
}

export function emailVerified(claims: Claims): boolean {
  const value = claims.email_verified;
  if (typeof value === "string") return ["1", "true", "yes"].includes(value.trim().toLowerCase());
  // A malformed claim must not authorize linking an app user by email.
  return value === true;
}

export function claimGroups(claims: Claims): Set<string> {
  let groups = claims[config().OIDC_GROUPS_CLAIM] ?? [];
  if (typeof groups === "string") groups = [groups];
  if (!Array.isArray(groups)) return new Set();
  return new Set(groups.filter((group): group is string => typeof group === "string"));
}

/**
 * Whether a configured group is among the claimed groups. Keycloak sends full
 * paths ("/iam/admins") when the mapper has "Full group path" on, so a name
 * without a slash also matches that top-level group ("/admins"). Security: it
 * never matches a group of that name further down, or everyone in any
 * "/team/admins" would get the role.
 */
export function groupMatches(name: string, groups: Set<string>): boolean {
  return groups.has(name) || (!name.includes("/") && groups.has(`/${name}`));
}

export function roleFromGroups(claims: Claims): Role | null {
  const groups = claimGroups(claims);
  const settings = config();
  const rules: [Role, string[]][] = [
    ["admin", settings.adminGroups],
    ["approver", settings.approverGroups],
    ["viewer", settings.viewerGroups],
  ];
  for (const [role, names] of rules) {
    if (names.some((name) => groupMatches(name, groups))) return role;
  }
  return null;
}

export function groupRolesConfigured(): boolean {
  const settings = config();
  return settings.adminGroups.length + settings.approverGroups.length + settings.viewerGroups.length > 0;
}

function nameOf(claims: Claims): string {
  const name =
    (typeof claims.name === "string" && claims.name) ||
    [claims.given_name, claims.family_name].filter((part) => typeof part === "string" && part).join(" ");
  return (name || "").slice(0, 200);
}

function emailOf(claims: Claims): string {
  return (typeof claims.email === "string" ? claims.email : "").trim().toLowerCase();
}

/** The app users these claims may sign in as. */
async function usersForClaims(claims: Claims): Promise<User[]> {
  const subject = String(claims.sub);
  const bySubject = await q().select().from(users).where(eq(users.oidcSubject, subject));
  if (bySubject.length > 0) return bySubject;
  const email = emailOf(claims);
  if (email && emailVerified(claims)) {
    // Also a user a concurrent first sign-in just bound to this subject.
    return q()
      .select()
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = ${email}`,
          or(isNull(users.oidcSubject), eq(users.oidcSubject, subject)),
        ),
      );
  }
  return [];
}

async function createUser(claims: Claims): Promise<User | null> {
  const email = emailOf(claims);
  if (!email || !emailVerified(claims)) return null;
  let role = roleFromGroups(claims);
  let source: User["roleSource"] = "provider";
  if (role === null && config().bootstrapAdminEmails.includes(email)) {
    const admins = await q()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.isActive, true)))
      .limit(1);
    if (admins.length > 0) return null;
    role = "admin";
    source = "local";
  }
  if (role === null) return null;
  const taken = await q()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (taken.length > 0) return null;
  const [user] = await q()
    .insert(users)
    .values({ email, role, roleSource: source, displayName: nameOf(claims), oidcSubject: String(claims.sub) })
    .returning();
  await record("user.created", `Created app user ${email} (${ROLE_LABELS[role]}) at first sign-in`, {
    actor: user!,
    target: { type: "user", id: user!.id },
    details: { role_source: source },
  });
  return user!;
}

async function updateUser(found: User, claims: Claims): Promise<User> {
  return atomic(async () => {
    // A concurrent sign-in or admin edit may have changed the match.
    const [user] = await q().select().from(users).where(eq(users.id, found.id)).for("no key update");
    if (!user) throw new SignInRefused("The app user was removed during sign-in.");
    const subject = String(claims.sub);
    if (
      user.oidcSubject !== subject &&
      (user.oidcSubject !== null || !emailVerified(claims) || user.email.toLowerCase() !== emailOf(claims))
    ) {
      throw new SignInRefused("App user identity changed during sign-in.");
    }
    const changes: Partial<User> = {};
    if (user.oidcSubject !== subject) changes.oidcSubject = subject;
    const name = nameOf(claims);
    if (name && name !== user.displayName) changes.displayName = name;
    if (groupRolesConfigured() && user.roleSource === "provider") {
      const role = roleFromGroups(claims);
      if (role === null) {
        if (user.isActive) changes.isActive = false;
      } else if (role !== user.role) {
        changes.role = role;
      }
    }
    const fields = Object.keys(changes).map((key) => FIELD_NAMES[key] ?? key);
    if (fields.length === 0) return user;
    const [updated] = await q().update(users).set(changes).where(eq(users.id, user.id)).returning();
    if (changes.isActive === false) await q().delete(sessions).where(eq(sessions.userId, user.id));
    const details: Record<string, unknown> = { fields: [...fields].sort() };
    if ("role" in changes) details.role = [user.role, updated!.role];
    if ("isActive" in changes) details.is_active = [user.isActive, updated!.isActive];
    let summary: string;
    if ("isActive" in changes) summary = `Turned off app user ${user.email}: no group claim grants a role`;
    else if ("role" in changes) {
      summary = `Changed the role of app user ${user.email} to ${ROLE_LABELS[updated!.role].toLowerCase()} from a group claim`;
    } else summary = `Updated app user ${user.email} at sign-in`;
    await record("user.signed_in", summary, {
      actor: updated!,
      target: { type: "user", id: user.id },
      details,
    });
    return updated!;
  });
}

const FIELD_NAMES: Record<string, string> = {
  oidcSubject: "oidc_subject",
  displayName: "display_name",
  isActive: "is_active",
  role: "role",
};

/**
 * The active app user these verified claims sign in as, or null when the
 * person has none. Throws SignInRefused for claims that must not sign in.
 */
export async function userForClaims(claims: Claims): Promise<User | null> {
  if (!claims.sub) return null;
  for (let attempt = 1; ; attempt += 1) {
    const found = await usersForClaims(claims);
    if (found.length > 1) throw new SignInRefused("Multiple users returned");
    if (found.length === 1) {
      const user = await updateUser(found[0]!, claims);
      return user.isActive ? user : null;
    }
    let created: User | null;
    try {
      created = await createUser(claims);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      created = null;
    }
    // Not created: a concurrent first sign-in may have created this user
    // meanwhile (the email taken, an admin there); look once more.
    if (created || attempt > 1) return created && created.isActive ? created : null;
  }
}
