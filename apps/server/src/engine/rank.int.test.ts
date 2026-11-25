import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { people, sessions, users } from "../db/schema";
import { startWorkflow } from "./lifecycle";
import { makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

describe("people with a higher role in this app", () => {
  useEngineFixtures();
  let restore: () => void;
  beforeAll(() => {
    restore = signInWithTestHeader();
  });
  afterAll(() => restore());

  it("are changed only by someone with that role, in every workflow", async () => {
    const { person } = await standardSetup();
    await getDb().update(people).set({ status: "active" }).where(eq(people.id, person.id));
    await makeUser("admin", "ada@example.invalid", { personId: person.id });
    const approver = await makeUser("approver");
    await expect(startWorkflow(person.id, "access_update", { actor: approver })).rejects.toThrow(
      "Ada Lovelace is an admin of this app. Only someone with that role can start the access update.",
    );
    await expect(startWorkflow(person.id, "offboarding", { actor: approver })).rejects.toThrow(
      "Only someone with that role can start the offboarding.",
    );
    const admin = await makeUser("admin", "boss@example.invalid");
    expect((await startWorkflow(person.id, "access_update", { actor: admin })).kind).toBe("access_update");
  });

  it("lose their sessions when an admin turns them off", async () => {
    const admin = await makeUser("admin");
    const viewer = await makeUser("viewer");
    await getDb()
      .insert(sessions)
      .values({ id: "a".repeat(64), userId: viewer.id, expiresAt: new Date(Date.now() + 3600_000) });
    const response = await request("PUT", `/api/v1/users/${viewer.id}`, {
      user: admin,
      body: { email: viewer.email, displayName: "", role: "viewer", isActive: false, personId: null },
    });
    expect(response.status).toBe(200);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, viewer.id))).toEqual([]);
    const [saved] = await getDb().select().from(users).where(eq(users.id, viewer.id));
    expect(saved!.isActive).toBe(false);
  });
});
