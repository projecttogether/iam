import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_WORKFLOW_STATUSES } from "@iam/shared/labels";
import { getDb, getPool } from "../db/client";
import {
  auditEvents,
  people,
  users,
  workflows,
  type Person,
  type PersonStatus,
  type WorkflowKind,
} from "../db/schema";
import { makePerson, makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

/**
 * Port of tests/test_views.py: the person form and the person page. Form
 * errors are 422 with `error.fields` (by the API's field names).
 */

const NEW_PERSON = {
  firstName: "",
  lastName: "",
  workEmail: "",
  personalEmail: "",
  username: "",
  jobTitle: "",
  personType: "employee",
  teamId: null,
  managerId: null,
  accessProfileId: null,
  startDate: null,
  endDate: null,
  notes: "",
};

/** The edit form of a person as the web app sends it, with changes. */
function edited(person: Person, changes: Record<string, unknown> = {}) {
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    workEmail: person.workEmail ?? "",
    personalEmail: person.personalEmail,
    username: person.username,
    jobTitle: person.jobTitle,
    personType: person.personType,
    teamId: person.teamId,
    managerId: person.managerId,
    accessProfileId: person.accessProfileId,
    startDate: person.startDate,
    endDate: person.endDate,
    notes: person.notes,
    ...changes,
  };
}

async function personById(id: number): Promise<Person> {
  const [person] = await getDb().select().from(people).where(eq(people.id, id));
  return person!;
}

/** The statuses each workflow may start from, as in iam/lifecycle.py of the Django version. */
const ALLOWED_FROM: Record<WorkflowKind, PersonStatus[]> = {
  onboarding: ["planned", "offboarded", "archived"],
  access_update: ["onboarding", "active"],
  offboarding: ["planned", "onboarding", "active", "offboarding", "offboarded"],
};

describe("people", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("finds people by their full name, archived ones too", async () => {
    const viewer = await makeUser("viewer");
    await makePerson({ firstName: "Grace", lastName: "Brewster", workEmail: null, status: "archived" });
    const found = await request("GET", "/api/v1/people?q=grace%20brewster", { user: viewer });
    expect(found.body.items.map((person: { name: string }) => person.name)).toEqual(["Grace Brewster"]);
  });

  it("adds a person with the default profile of the type, and audits it", async () => {
    const { profile } = await standardSetup();
    const approver = await makeUser("approver");
    const response = await request("POST", "/api/v1/people", {
      user: approver,
      body: { ...NEW_PERSON, firstName: "Grace", lastName: "Hopper", workEmail: "Grace@Example.invalid" },
    });
    expect(response.status).toBe(201);
    const [person] = await getDb().select().from(people).where(eq(people.lastName, "Hopper"));
    expect(response.body.id).toBe(person!.id);
    expect(person!.workEmail).toBe("grace@example.invalid");
    expect(person!.accessProfileId).toBe(profile.id);
    const events = await getDb()
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "person.created"),
          eq(auditEvents.personId, person!.id),
          eq(auditEvents.actorId, approver.id),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("refuses an end date before the start date", async () => {
    const approver = await makeUser("approver");
    const response = await request("POST", "/api/v1/people", {
      user: approver,
      body: { ...NEW_PERSON, firstName: "A", lastName: "B", startDate: "2026-12-01", endDate: "2026-11-01" },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.endDate).toContain("cannot be before");
    expect(await getDb().select().from(people)).toEqual([]);
  });

  it("refuses a date that is not in the calendar, and takes Django's email addresses", async () => {
    const approver = await makeUser("approver");
    const invalid = await request("POST", "/api/v1/people", {
      user: approver,
      body: { ...NEW_PERSON, firstName: "A", lastName: "B", startDate: "2026-02-30" },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.fields.startDate).toBe("Enter a valid date.");
    const local = await request("POST", "/api/v1/people", {
      user: approver,
      body: { ...NEW_PERSON, firstName: "A", lastName: "B", workEmail: "ops@localhost" },
    });
    expect(local.status).toBe(201);
  });

  it("lets only an admin change the end date of a person linked to an admin", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    const admin = await makeUser("admin");
    await getDb().update(users).set({ personId: person.id }).where(eq(users.id, admin.id));
    const url = `/api/v1/people/${person.id}`;

    expect(
      (await request("PUT", url, { user: approver, body: edited(person, { notes: "Updated notes" }) }))
        .status,
    ).toBe(200);
    const fields = edited(person, { notes: "Updated notes", endDate: "2030-01-01" });
    const refused = await request("PUT", url, { user: approver, body: fields });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.endDate).toBeTruthy();
    let saved = await personById(person.id);
    expect(saved.endDate).toBeNull();
    expect(saved.notes).toBe("Updated notes");

    expect((await request("PUT", url, { user: admin, body: fields })).status).toBe(200);
    saved = await personById(person.id);
    expect(saved.endDate).toBe("2030-01-01");
  });

  it("starts a workflow from the person page", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    const response = await request("POST", `/api/v1/people/${person.id}/start/onboarding`, {
      user: approver,
      body: {},
    });
    expect(response.status).toBe(200);
    const [workflow, ...others] = await getDb().select().from(workflows);
    expect(others).toEqual([]);
    // The Django version redirected to the workflow's page.
    expect(response.body.id).toBe(workflow!.id);
    expect(workflow!.createdById).toBe(approver.id);
    const update = await request("POST", `/api/v1/people/${person.id}/start/access_update`, {
      user: approver,
      body: {},
    });
    expect(update.status).toBe(200);
  });

  it.each(["planned", "onboarding", "active", "offboarding", "offboarded", "archived"] as const)(
    "offers on the person page what the lifecycle allows (%s)",
    async (status) => {
      const { person } = await standardSetup();
      const approver = await makeUser("approver");
      await getDb().update(people).set({ status }).where(eq(people.id, person.id));
      const page = await request("GET", `/api/v1/people/${person.id}`, { user: approver });
      expect(page.status).toBe(200);
      expect(page.body.can).toEqual({
        onboard: ALLOWED_FROM.onboarding.includes(status),
        update: ALLOWED_FROM.access_update.includes(status),
        offboard: ALLOWED_FROM.offboarding.includes(status),
        archive: status === "planned" || status === "offboarded",
      });
    },
  );

  it("offboards an offboarded person again from their page", async () => {
    // Fixing drift: an offboarded person still has an active account somewhere.
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await getDb().update(people).set({ status: "offboarded" }).where(eq(people.id, person.id));
    const page = await request("GET", `/api/v1/people/${person.id}`, { user: approver });
    expect(page.body.can.offboard).toBe(true);
    expect(
      (await request("POST", `/api/v1/people/${person.id}/start/offboarding`, { user: approver, body: {} }))
        .status,
    ).toBe(200);
    const [workflow] = await getDb().select().from(workflows).where(eq(workflows.kind, "offboarding"));
    expect(OPEN_WORKFLOW_STATUSES).toContain(workflow!.status);
  });

  it("lifts a paused onboarding with a new start date", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await getDb().update(people).set({ onboardingPaused: true }).where(eq(people.id, person.id));
    // The page says that the last onboarding was cancelled.
    expect(
      (await request("GET", `/api/v1/people/${person.id}`, { user: approver })).body.onboardingPaused,
    ).toBe(true);
    const paused = await personById(person.id);
    const response = await request("PUT", `/api/v1/people/${person.id}`, {
      user: approver,
      body: edited(paused, { startDate: "2027-01-04" }),
    });
    expect(response.status).toBe(200);
    expect((await personById(person.id)).onboardingPaused).toBe(false);
  });

  it("keeps a status that a workflow sets while the person is edited", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    await getDb().update(people).set({ status: "active" }).where(eq(people.id, person.id));
    const active = await personById(person.id);
    // Another connection changes the status and holds the row for half a second,
    // as a job or workflow committing at the same time would.
    const other = await getPool().connect();
    let response: Awaited<ReturnType<typeof request>>;
    try {
      await other.query("begin");
      await other.query("update iam_person set status = 'offboarding' where id = $1", [person.id]);
      const saving = request("PUT", `/api/v1/people/${person.id}`, {
        user: approver,
        body: edited(active, { lastName: "King" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await other.query("commit");
      response = await saving;
    } finally {
      other.release();
    }
    expect(response.status).toBe(200);
    const saved = await personById(person.id);
    expect(saved.lastName).toBe("King");
    expect(saved.status).toBe("offboarding");
  });
});
