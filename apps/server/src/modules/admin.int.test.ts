import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { loadSettings, notificationRecipients } from "../engine/settings";
import { makeUser, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

/** Port of tests/test_views.py: Admin › Users and roles, and Admin › Settings. */

describe("users and settings", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("keeps admins from locking themselves out", async () => {
    const admin = await makeUser("admin");
    const response = await request("PUT", `/api/v1/users/${admin.id}`, {
      user: admin,
      body: { email: admin.email, displayName: "", role: "viewer", isActive: true, personId: null },
    });
    // The Django version redirected with this message.
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("You cannot remove your own admin access.");
    const [kept] = await getDb().select().from(users).where(eq(users.id, admin.id));
    expect(kept!.role).toBe("admin");
    expect(kept!.isActive).toBe(true);
  });

  it("adds a user, who signs in only through the provider", async () => {
    const admin = await makeUser("admin");
    const response = await request("POST", "/api/v1/users", {
      user: admin,
      body: {
        email: "New@Example.invalid",
        displayName: "",
        role: "approver",
        isActive: true,
        personId: null,
      },
    });
    expect(response.status).toBe(201);
    const [user] = await getDb().select().from(users).where(eq(users.email, "new@example.invalid"));
    expect(user!.role).toBe("approver");
    // The Django user had an unusable password; this version keeps none at all.
    const passwords = await getDb().execute(
      sql`select 1 from information_schema.columns where table_name = 'iam_user' and column_name = 'password'`,
    );
    expect(passwords.rows).toEqual([]);
  });

  it("saves the settings", async () => {
    const admin = await makeUser("admin");
    const response = await request("PUT", "/api/v1/settings", {
      user: admin,
      body: {
        organizationName: "Example Org",
        automaticOnboarding: false,
        onboardingLeadDays: 3,
        automaticOffboarding: false,
        removalLimitPerDay: 2,
        notificationEmails: "it@example.invalid",
        identityRequestTypes: [],
      },
    });
    expect(response.status).toBe(200);
    const settings = await loadSettings();
    expect(settings.organizationName).toBe("Example Org");
    expect(settings.automaticOnboarding).toBe(false);
    expect(notificationRecipients(settings)).toEqual(["it@example.invalid"]);
  });
});
