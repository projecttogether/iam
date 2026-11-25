import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { overrideConfigForTests, resetConfigForTests } from "../config";
import { getDb, getPool } from "../db/client";
import { auditEvents, users } from "../db/schema";
import { createUser, eventually, resetDatabase } from "../test/helpers";
import { claims } from "../test/fake-provider";
import { SignInRefused, userForClaims } from "./claims";

/**
 * Port of tests/test_auth.py: which app user a sign-in's verified claims
 * sign in as (OIDCBackend's filter_users_by_claims, create_user and
 * update_user).
 */

async function userById(id: number) {
  const [user] = await getDb().select().from(users).where(eq(users.id, id));
  return user!;
}

const signedInEvents = () =>
  getDb()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "user.signed_in"))
    .orderBy(asc(auditEvents.id));

describe("users for sign-in claims", () => {
  beforeEach(async () => {
    await resetDatabase();
    resetConfigForTests();
  });

  it("matches an existing user by subject, or else by verified email", async () => {
    const invited = await createUser("approver", "ada@example.invalid");
    expect(await userForClaims(claims({ email_verified: false }))).toBeNull();
    expect((await userById(invited.id)).oidcSubject).toBeNull();

    expect((await userForClaims(claims({ name: "Ada Lovelace" })))?.id).toBe(invited.id);
    const bound = await userById(invited.id);
    expect(bound.oidcSubject).toBe("subject-1");
    expect(bound.displayName).toBe("Ada Lovelace");

    // Bound: the subject decides, whatever the address.
    expect((await userForClaims(claims({ email: "other@example.invalid" })))?.id).toBe(invited.id);
  });

  it("checks the identity again when the first sign-in commits", async () => {
    const invited = await createUser("approver", "ada@example.invalid");
    // Another sign-in binds subject-1 and holds the row until it commits.
    const other = await getPool().connect();
    try {
      await other.query("begin");
      await other.query("update iam_user set oidc_subject = 'subject-1' where id = $1", [invited.id]);
      // This sign-in still matches the user without a subject, then waits for the row.
      const signingIn = userForClaims(claims({ sub: "subject-2" }));
      signingIn.catch(() => undefined);
      await eventually(async () => {
        const rows = await getDb().execute(
          sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
        );
        return rows.rows.length > 0 ? true : undefined;
      }, 5_000);
      await other.query("commit");
      await expect(signingIn).rejects.toThrow(SignInRefused);
      await expect(signingIn).rejects.toThrow(/identity changed/);
    } finally {
      other.release();
    }
    expect((await userById(invited.id)).oidcSubject).toBe("subject-1");
  });

  it("creates no user for unknown people", async () => {
    expect(await userForClaims(claims())).toBeNull();
    expect(await getDb().select().from(users)).toEqual([]);
  });

  it("makes a bootstrap admin only while no admin exists", async () => {
    overrideConfigForTests({ bootstrapAdminEmails: ["ada@example.invalid"] });
    expect(await userForClaims(claims({ email_verified: false }))).toBeNull();
    const user = (await userForClaims(claims()))!;
    expect(user.role).toBe("admin");
    expect(user.roleSource).toBe("local");
    overrideConfigForTests({ bootstrapAdminEmails: ["ada@example.invalid", "eve@example.invalid"] });
    expect(await userForClaims(claims({ sub: "s2", email: "eve@example.invalid" }))).toBeNull();
    expect(await getDb().select().from(users)).toHaveLength(1);
  });

  it("grants and revokes roles by group claims", async () => {
    overrideConfigForTests({ adminGroups: ["/iam/admins"], viewerGroups: ["iam-viewers"] });
    const user = (await userForClaims(claims({ groups: ["/staff", "/iam/admins"] })))!;
    expect(user.role).toBe("admin");
    expect(user.roleSource).toBe("provider");
    expect((await userForClaims(claims({ groups: ["/iam-viewers"] })))?.role).toBe("viewer");
    expect((await userForClaims(claims({ groups: ["iam-viewers"] })))?.role).toBe("viewer");
    expect(await userForClaims(claims({ groups: [] }))).toBeNull();
    expect((await userById(user.id)).isActive).toBe(false);
  });

  it("creates one user for simultaneous first sign-ins", async () => {
    overrideConfigForTests({ adminGroups: ["/iam/admins"] });
    // Open the connections first, so the sign-ins run side by side.
    await Promise.all(Array.from({ length: 8 }, () => getPool().query("select pg_sleep(0.05)")));
    const signedIn = await Promise.all(
      Array.from({ length: 8 }, () => userForClaims(claims({ groups: ["/iam/admins"] }))),
    );
    const ids = new Set(signedIn.map((user) => user?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTypeOf("number");
    expect(await getDb().$count(users)).toBe(1);
  });

  it("leaves local roles to the app", async () => {
    overrideConfigForTests({ adminGroups: ["admins"] });
    const user = await createUser("approver", "ada@example.invalid");
    expect((await userForClaims(claims({ groups: [] })))?.id).toBe(user.id);
    const kept = await userById(user.id);
    expect(kept.isActive).toBe(true);
    expect(kept.role).toBe("approver");
  });

  it("audits role changes from group claims", async () => {
    overrideConfigForTests({ adminGroups: ["/iam/admins"], viewerGroups: ["/iam/viewers"] });
    const user = (await userForClaims(claims({ groups: ["/iam/viewers"] })))!;
    await userForClaims(claims({ groups: ["/iam/admins"] }));
    const [promoted, ...others] = await signedInEvents();
    expect(others).toEqual([]);
    expect(promoted!.details.role).toEqual(["viewer", "admin"]);

    await userForClaims(claims({ groups: [] }));
    const turnedOff = (await signedInEvents()).at(-1)!;
    expect(turnedOff.details.is_active).toEqual([true, false]);
    expect(JSON.stringify(turnedOff.details)).not.toContain("subject-1");
    expect((await userById(user.id)).isActive).toBe(false);

    await userForClaims(claims({ groups: [] })); // signing in again changes nothing
    expect(await signedInEvents()).toHaveLength(2);
  });
});
