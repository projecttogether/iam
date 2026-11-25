import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { apiKeys, appSettings, auditEvents, identityRequests, people } from "../db/schema";
import type { PersonType } from "../db/schema";
import { loadSettings } from "../engine/settings";
import { makePerson, makeTeam, makeUser, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

/** Identity requests: the API for other apps (API key), the inbox, API keys and the setting. */

async function allow(...types: PersonType[]) {
  await loadSettings();
  await getDb().update(appSettings).set({ identityRequestTypes: types }).where(eq(appSettings.id, 1));
}

/** Creates a key through Admin › API keys and returns it. */
async function createKey(name = "Helpdesk"): Promise<string> {
  const admin = await makeUser("admin", `admin-${name.toLowerCase()}@example.invalid`);
  const response = await request("POST", "/api/v1/api-keys", { user: admin, body: { name } });
  expect(response.status).toBe(201);
  return response.body.key as string;
}

/** A call to the API for other apps: with the key, without the app's origin or a session. */
async function call(method: string, path: string, key: string | null, body?: unknown) {
  return request(method, `/api/integration/v1${path}`, {
    body,
    headers: { origin: "", ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
}

const REQUEST = {
  externalId: "helpdesk:ticket:42",
  externalUrl: "https://helpdesk.example.invalid/tickets/42",
  requestedBy: { name: "Hanna HR", email: "Hanna@Example.invalid" },
  firstName: "Grace",
  lastName: "Hopper",
  personalEmail: "grace@personal.example.invalid",
  personType: "intern",
  startDate: "2027-01-04",
  notes: "Needs a laptop.",
};

const PERSON_FORM = {
  firstName: "Grace",
  lastName: "Hopper",
  workEmail: "grace@example.invalid",
  personalEmail: "grace@personal.example.invalid",
  username: "",
  jobTitle: "",
  personType: "intern",
  teamId: null,
  managerId: null,
  accessProfileId: null,
  startDate: "2027-01-04",
  endDate: null,
  notes: "",
};

describe("identity requests", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("lets only valid, unrevoked keys in, and keys reach nothing else", async () => {
    const key = await createKey();
    expect((await call("GET", "/identity-requests/options", null)).status).toBe(401);
    expect((await call("GET", "/identity-requests/options", `iam_${"x".repeat(43)}`)).status).toBe(401);
    const response = await call("GET", "/identity-requests/options", key);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    // A signed-in user without a key does not reach the API for other apps.
    const admin = await makeUser("admin", "boss@example.invalid");
    const withSession = await request("GET", "/api/integration/v1/identity-requests/options", {
      user: admin,
    });
    expect(withSession.status).toBe(401);
    // The key does not reach the web app's API.
    const people = await request("GET", "/api/v1/people", {
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });
    expect(people.status).toBe(401);

    const [row] = await getDb().select().from(apiKeys);
    expect(row!.keyHash).not.toContain(key);
    expect(row!.lastUsedAt).not.toBeNull();
    const revoked = await request("POST", `/api/v1/api-keys/${row!.id}/revoke`, { user: admin });
    expect(revoked.status).toBe(200);
    expect((await call("GET", "/identity-requests/options", key)).status).toBe(401);
  });

  it("accepts only the person types chosen in the settings", async () => {
    const key = await createKey();
    const off = await call("POST", "/identity-requests", key, REQUEST);
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe("identity_requests_off");

    await allow("employee", "volunteer");
    const options = await call("GET", "/identity-requests/options", key);
    expect(options.body.personTypes).toEqual([
      { value: "employee", label: "Employee" },
      { value: "volunteer", label: "Volunteer" },
    ]);
    const refused = await call("POST", "/identity-requests", key, REQUEST);
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.personType).toBe(
      "This installation accepts no identity requests for interns.",
    );
    expect(await getDb().select().from(identityRequests)).toEqual([]);
  });

  it("stores a request once per reference, audits it, and checks its fields", async () => {
    const key = await createKey();
    await allow("intern");
    const team = await makeTeam([], "Research");
    const created = await call("POST", "/identity-requests", key, { ...REQUEST, teamId: team.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      externalId: "helpdesk:ticket:42",
      status: "open",
      reason: "",
      person: null,
      decidedAt: null,
    });
    expect(created.body.url).toMatch(/\/requests\/\d+$/);

    // The same details again (spelled with other spaces and capitals where IAM normalizes them): the same request.
    const again = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      firstName: " Grace ",
      teamId: team.id,
    });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);
    // Email addresses in other capitals are the same details: the fingerprint lower-cases them.
    const capitals = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      teamId: team.id,
      requestedBy: { name: "Hanna HR", email: "HANNA@example.invalid" },
      personalEmail: "Grace@Personal.example.invalid",
    });
    expect(capitals.status).toBe(200);
    // Other details under the same reference: refused, so the sender cannot believe IAM holds them.
    const changed = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      firstName: "Other",
      teamId: team.id,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("reference_reused");
    const rows = await getDb().select().from(identityRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      firstName: "Grace",
      teamId: team.id,
      requestedByEmail: "hanna@example.invalid",
      personType: "intern",
    });
    const [event] = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "identity_request.received"));
    expect(event!.actorLabel).toBe('API key "Helpdesk"');

    const invalid = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      externalId: "helpdesk:ticket:43",
      personalEmail: "not an address",
      externalUrl: "javascript:alert(1)",
    });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.error.fields).sort()).toEqual(["externalUrl", "personalEmail"]);
    const backwards = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      externalId: "helpdesk:ticket:43",
      endDate: "2026-01-01",
    });
    expect(backwards.body.error.fields).toEqual({ endDate: "The last day cannot be before the start date." });
    const unknownTeam = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      externalId: "helpdesk:ticket:44",
      teamId: 99_999,
    });
    expect(unknownTeam.status).toBe(422);
    expect(unknownTeam.body.error.fields.teamId).toBeDefined();
  });

  it("creates the person on approval, and the sender reads the outcome", async () => {
    const key = await createKey();
    await allow("intern");
    const { body: sent } = await call("POST", "/identity-requests", key, REQUEST);
    const viewer = await makeUser("viewer");
    const approver = await makeUser("approver");

    const list = await request("GET", "/api/v1/identity-requests", { user: viewer });
    expect(list.body.items.map((item: { name: string }) => item.name)).toEqual(["Grace Hopper"]);
    const detail = await request("GET", `/api/v1/identity-requests/${sent.id}`, { user: viewer });
    expect(detail.body).toMatchObject({ source: "Helpdesk", requestedByName: "Hanna HR", status: "open" });
    const me = await request("GET", "/api/v1/me", { user: viewer });
    expect(me.body.counts.openRequests).toBe(1);

    const denied = await request("POST", `/api/v1/identity-requests/${sent.id}/approve`, {
      user: viewer,
      body: PERSON_FORM,
    });
    expect(denied.status).toBe(403);

    const approved = await request("POST", `/api/v1/identity-requests/${sent.id}/approve`, {
      user: approver,
      body: PERSON_FORM,
    });
    expect(approved.status).toBe(200);
    const [person] = await getDb().select().from(people).where(eq(people.id, approved.body.id));
    expect(person).toMatchObject({
      firstName: "Grace",
      workEmail: "grace@example.invalid",
      status: "planned",
    });

    const read = await call("GET", `/identity-requests/${sent.id}`, key);
    expect(read.body).toMatchObject({
      status: "approved",
      person: { status: "planned", workEmail: "grace@example.invalid", startDate: "2027-01-04" },
    });
    expect(read.body.decidedAt).not.toBeNull();

    const twice = await request("POST", `/api/v1/identity-requests/${sent.id}/reject`, {
      user: approver,
      body: { reason: "Too late" },
    });
    expect(twice.status).toBe(409);
    const cancel = await call("POST", `/identity-requests/${sent.id}/cancel`, key);
    expect(cancel.status).toBe(409);
  });

  it("keeps the request open when the person form is invalid", async () => {
    const key = await createKey();
    await allow("intern");
    await makePerson({ workEmail: "grace@example.invalid" });
    const { body: sent } = await call("POST", "/identity-requests", key, REQUEST);
    const approver = await makeUser("approver");
    const response = await request("POST", `/api/v1/identity-requests/${sent.id}/approve`, {
      user: approver,
      body: PERSON_FORM,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.workEmail).toBe("Person with this Work email already exists.");
    const [row] = await getDb().select().from(identityRequests);
    expect(row!.status).toBe("open");
    expect(await getDb().select().from(people)).toHaveLength(1);
  });

  it("links a person already here, rejects with a reason, and lets the sender cancel", async () => {
    const key = await createKey();
    await allow("intern");
    const existing = await makePerson({ personalEmail: "grace@personal.example.invalid", firstName: "G." });
    await makePerson({
      firstName: "Old",
      lastName: "Boss",
      workEmail: "boss@example.invalid",
      status: "archived",
    });
    const approver = await makeUser("approver");

    const { body: first } = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      managerEmail: "boss@example.invalid",
    });
    const detail = await request("GET", `/api/v1/identity-requests/${first.id}`, { user: approver });
    // An archived person is no manager: the approval form must not pick them.
    expect(detail.body).toMatchObject({ managerEmail: "boss@example.invalid", manager: null });
    expect(detail.body.matches).toEqual([
      expect.objectContaining({ id: existing.id, reason: "Same personal email" }),
    ]);
    const linked = await request("POST", `/api/v1/identity-requests/${first.id}/link`, {
      user: approver,
      body: { personId: existing.id },
    });
    expect(linked.status).toBe(200);
    expect((await call("GET", `/identity-requests/${first.id}`, key)).body.person.workEmail).toBe(
      "ada@example.invalid",
    );

    const { body: second } = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      externalId: "helpdesk:ticket:50",
    });
    const noReason = await request("POST", `/api/v1/identity-requests/${second.id}/reject`, {
      user: approver,
      body: { reason: " " },
    });
    expect(noReason.status).toBe(422);
    await request("POST", `/api/v1/identity-requests/${second.id}/reject`, {
      user: approver,
      body: { reason: "No contract yet." },
    });
    expect((await call("GET", `/identity-requests/${second.id}`, key)).body).toMatchObject({
      status: "rejected",
      reason: "No contract yet.",
      person: null,
    });

    const { body: third } = await call("POST", "/identity-requests", key, {
      ...REQUEST,
      externalId: "helpdesk:ticket:51",
    });
    const cancelled = await call("POST", `/identity-requests/${third.id}/cancel`, key);
    expect(cancelled.body.status).toBe("cancelled");
    expect((await call("POST", `/identity-requests/${third.id}/cancel`, key)).status).toBe(200);
    const late = await request("POST", `/api/v1/identity-requests/${third.id}/approve`, {
      user: approver,
      body: PERSON_FORM,
    });
    expect(late.status).toBe(409);
    expect((await call("GET", "/identity-requests/99999", key)).status).toBe(404);
  });

  it("lets only admins manage keys and shows a key only once", async () => {
    const approver = await makeUser("approver");
    expect((await request("GET", "/api/v1/api-keys", { user: approver })).status).toBe(403);
    expect((await request("POST", "/api/v1/api-keys", { user: approver, body: { name: "X" } })).status).toBe(
      403,
    );
    const key = await createKey("Scripts");
    expect(key).toMatch(/^iam_[A-Za-z0-9_-]{43}$/);
    const admin = await makeUser("admin");
    const list = await request("GET", "/api/v1/api-keys", { user: admin });
    expect(list.body).toEqual([
      expect.objectContaining({ name: "Scripts", prefix: key.slice(0, 12), revokedAt: null }),
    ]);
    expect(list.text).not.toContain(key);
  });

  it("saves the person types other apps may request", async () => {
    const admin = await makeUser("admin");
    const response = await request("PUT", "/api/v1/settings", {
      user: admin,
      body: {
        organizationName: "Example Org",
        automaticOnboarding: true,
        onboardingLeadDays: 7,
        automaticOffboarding: true,
        removalLimitPerDay: 5,
        notificationEmails: "",
        identityRequestTypes: ["volunteer", "employee", "volunteer"],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.identityRequestTypes).toEqual(["employee", "volunteer"]);
    const [event] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, "settings.saved"));
    expect(event!.details).toEqual({ fields: ["identity_request_types", "organization_name"] });
  });

  it("points approvers to other requests that may be for the same person", async () => {
    const key = await createKey();
    await allow("intern", "volunteer");
    const approver = await makeUser("approver");
    const send = async (externalId: string, changes: Record<string, unknown> = {}) =>
      (await call("POST", "/identity-requests", key, { ...REQUEST, externalId, ...changes })).body
        .id as number;
    const first = await send("helpdesk:a");
    const sameEmail = await send("helpdesk:b", { firstName: "G.", startDate: "2027-02-01" });
    const sameNameAndStart = await send("helpdesk:c", { personalEmail: "other@personal.example.invalid" });
    await send("helpdesk:d", { firstName: "Ada", personalEmail: "", startDate: "2027-01-04" });
    const rejected = await send("helpdesk:e");
    await request("POST", `/api/v1/identity-requests/${rejected}/reject`, {
      user: approver,
      body: { reason: "Duplicate." },
    });

    const detail = await request("GET", `/api/v1/identity-requests/${first}`, { user: approver });
    expect(
      detail.body.duplicates.map((other: { id: number; reason: string }) => [other.id, other.reason]),
    ).toEqual([
      [sameNameAndStart, "Same name and start date"],
      [sameEmail, "Same personal email"],
    ]);
    expect(detail.body.duplicates[0]).toMatchObject({ source: "Helpdesk" });
    // Without an email and a start date nothing marks a duplicate, not even the same name.
    const bare = await send("helpdesk:f", { personalEmail: "", startDate: null });
    const bareDetail = await request("GET", `/api/v1/identity-requests/${bare}`, { user: approver });
    expect(bareDetail.body.duplicates).toEqual([]);
  });
});
