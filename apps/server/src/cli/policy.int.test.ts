import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { auditEvents, people, providerGroups, workflows, type AuditEvent } from "../db/schema";
import {
  makeConnection,
  makeGroups,
  makePerson,
  makeProfile,
  makeTeam,
  makeUser,
  useEngineFixtures,
} from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";
import type { Io } from "./command";
import { runPeople } from "./people";
import { runGroups, runProfiles, runTeams } from "./policy";

/**
 * `cli groups`, `cli teams`, `cli profiles` and `cli people` against the
 * database: they do what the Teams, Access profiles and People pages do (the
 * same checks, the same audit events), as the operator.
 */

type Command = (args: string[], io: Io) => Promise<number>;

async function cli(command: Command, args: string[], stdin?: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    readStdin: async () =>
      typeof stdin === "string" ? stdin : stdin === undefined ? "" : JSON.stringify(stdin),
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const code = await command(args, io);
  return { code, out: out.join(""), err: err.join("") };
}

async function events(action: string): Promise<AuditEvent[]> {
  return getDb().select().from(auditEvents).where(eq(auditEvents.action, action));
}

const PERSON = {
  firstName: "Grace",
  lastName: "Hopper",
  workEmail: "grace@example.invalid",
  personalEmail: "",
  username: "",
  jobTitle: "",
  personType: "employee",
  teamId: null,
  managerId: null,
  accessProfileId: null,
  startDate: "2020-01-06",
  endDate: "",
  notes: "",
};

describe("cli groups, teams, profiles and people", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("lists the groups a team or profile can grant, with their IDs", async () => {
    const connection = await makeConnection();
    const groups = await makeGroups(connection);
    const listed = await cli(runGroups, ["list"]);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain(`${groups["g-eng"]!.id}  Fake app: Engineering\n`);
    const asJson = JSON.parse((await cli(runGroups, ["list", "--json"])).out);
    const admin = await makeUser("admin");
    expect(asJson).toEqual((await request("GET", "/api/v1/group-connections", { user: admin })).body);
  });

  it("adds, shows, saves and removes a team as the page does", async () => {
    const connection = await makeConnection();
    const groups = await makeGroups(connection);
    const added = await cli(runTeams, ["apply"], {
      name: "Research",
      description: "",
      groupIds: [groups["g-eng"]!.id],
    });
    expect(added.code, added.err).toBe(0);
    const form = JSON.parse(added.out);
    expect(form).toEqual({
      id: form.id,
      name: "Research",
      description: "",
      groupIds: [groups["g-eng"]!.id],
      groups: ["Fake app: Engineering"],
      members: 0,
    });
    expect(added.err).toBe(`Saved team Research. ID: ${form.id}\n`);
    const [event] = await events("team.saved");
    expect(event).toMatchObject({
      actorId: null,
      actorLabel: "operator",
      details: { command: "cli teams apply", groups: ["Engineering"] },
    });

    // `show` prints the body `apply --id` takes.
    const shown = await cli(runTeams, ["show", "--id", String(form.id)]);
    expect(JSON.parse(shown.out)).toEqual(form);
    const saved = await cli(runTeams, ["apply", "--id", String(form.id)], {
      ...form,
      groupIds: [groups["g-ops"]!.id],
    });
    expect(saved.code, saved.err).toBe(0);
    expect(JSON.parse(saved.out).groups).toEqual(["Fake app: Operations"]);
    expect((await cli(runTeams, ["list"])).out).toMatch(/^--id \d+ {2}Research; 0 members; 1 groups\n$/);

    // A group the last import no longer found is dropped, as the form drops it.
    await getDb()
      .update(providerGroups)
      .set({ missing: true })
      .where(eq(providerGroups.id, groups["g-ops"]!.id));
    const dropped = await cli(runTeams, ["apply", "--id", String(form.id)], {
      ...form,
      groupIds: [groups["g-ops"]!.id, groups["g-eng"]!.id],
    });
    expect(JSON.parse(dropped.out).groups).toEqual(["Fake app: Engineering"]);

    // The page's checks: a taken name, an unknown ID.
    const taken = await cli(runTeams, ["apply"], { name: "Research", description: "", groupIds: [] });
    expect(taken).toMatchObject({ code: 1 });
    expect(taken.err).toContain("name: Team with this Name already exists.");
    const unknown = await cli(runTeams, ["apply", "--id", "999"], {
      name: "X",
      description: "",
      groupIds: [],
    });
    expect(unknown).toMatchObject({ code: 1, err: "No team has the ID 999.\n" });

    const removed = await cli(runTeams, ["remove", "--id", String(form.id)]);
    expect(removed).toMatchObject({ code: 0, err: "Deleted team Research.\n" });
    expect((await cli(runTeams, ["list"])).out).toBe("No teams.\n");
  });

  it("adds and saves an access profile, and keeps one that people have", async () => {
    const connection = await makeConnection();
    const groups = await makeGroups(connection);
    const added = await cli(runProfiles, ["apply"], {
      name: "Volunteer",
      description: "Unpaid helpers",
      defaultFor: ["volunteer"],
      grants: [{ connectionId: connection.id, groupIds: [groups["g-staff"]!.id] }],
    });
    expect(added.code, added.err).toBe(0);
    const form = JSON.parse(added.out);
    expect(form).toEqual({
      id: form.id,
      name: "Volunteer",
      description: "Unpaid helpers",
      defaultFor: ["volunteer"],
      grants: [
        {
          connectionId: connection.id,
          connection: "Fake app",
          groupIds: [groups["g-staff"]!.id],
          groups: ["Staff"],
        },
      ],
    });
    const [event] = await events("profile.saved");
    expect(event).toMatchObject({
      actorLabel: "operator",
      details: { command: "cli profiles apply", grants: { "Fake app": ["Staff"] } },
    });
    expect((await cli(runProfiles, ["list"])).out).toMatch(
      /^--id \d+ {2}Volunteer; 0 people; Fake app; default for Volunteer\n$/,
    );

    // The page's check: one default profile per person type.
    const clash = await cli(runProfiles, ["apply"], {
      name: "Helpers",
      description: "",
      defaultFor: ["volunteer"],
      grants: [],
    });
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("defaultFor: Volunteer is already the default for Volunteer.");

    await makePerson({ accessProfileId: form.id });
    const kept = await cli(runProfiles, ["remove", "--id", String(form.id)]);
    expect(kept).toMatchObject({ code: 1, err: "Volunteer is still assigned to people.\n" });
  });

  it("adds and edits people as the page does, with the default profile", async () => {
    const connection = await makeConnection();
    const groups = await makeGroups(connection);
    const profile = await makeProfile(connection, [groups["g-staff"]!]);
    const team = await makeTeam([groups["g-eng"]!]);

    const added = await cli(runPeople, ["apply"], PERSON);
    expect(added.code, added.err).toBe(0);
    const form = JSON.parse(added.out);
    expect(form).toEqual({ id: form.id, status: "planned", ...PERSON, accessProfileId: profile.id });
    expect(added.err).toBe(`Added Grace Hopper. ID: ${form.id}\n`);
    expect((await events("person.created"))[0]).toMatchObject({
      actorLabel: "operator",
      details: { command: "cli people apply" },
    });

    const { id, status: _status, ...body } = form;
    const saved = await cli(runPeople, ["apply", "--id", String(id)], { ...body, teamId: team.id });
    expect(saved.code, saved.err).toBe(0);
    expect(JSON.parse(saved.out)).toMatchObject({ teamId: team.id });
    expect((await events("person.updated"))[0]).toMatchObject({
      actorLabel: "operator",
      details: { command: `cli people apply --id ${id}`, fields: ["team"] },
    });
    expect((await cli(runPeople, ["show", "--id", String(id)])).out).toBe(saved.out);
    expect((await cli(runPeople, ["list"])).out).toBe(
      `--id ${id}  Grace Hopper; grace@example.invalid; employee; planned; team: Engineering; profile: Staff\n`,
    );

    // The page's checks: a taken work email, an unknown ID.
    const taken = await cli(runPeople, ["apply"], { ...PERSON, firstName: "Other" });
    expect(taken.code).toBe(1);
    expect(taken.err).toContain("workEmail: Person with this Work email already exists.");
    const unknown = await cli(runPeople, ["show", "--id", "999"]);
    expect(unknown).toMatchObject({ code: 1, err: "No person has the ID 999.\n" });
  });

  it("starts a workflow as the person's page does, as the operator", async () => {
    const connection = await makeConnection();
    const groups = await makeGroups(connection);
    const profile = await makeProfile(connection, [groups["g-staff"]!]);
    const person = await makePerson({ accessProfileId: profile.id, status: "active" });
    // An admin of the app: the operator has an admin's rights.
    await makeUser("admin", "ada-admin@example.invalid", { personId: person.id });

    const started = await cli(runPeople, ["start", "access_update", "--id", String(person.id)]);
    expect(started.code, started.err).toBe(0);
    const { workflowId } = JSON.parse(started.out);
    expect(started.err).toBe(`Started access update. Workflow ID: ${workflowId}\n`);
    const [workflow] = await getDb().select().from(workflows).where(eq(workflows.id, workflowId));
    expect(workflow).toMatchObject({ kind: "access_update", createdById: null, automatic: false });
    expect((await events("workflow.access_update"))[0]).toMatchObject({
      actorLabel: "operator",
      personId: person.id,
      details: { command: `cli people start access_update --id ${person.id}` },
    });

    // The page's refusal: onboarding needs a planned person with a profile.
    const planned = await makePerson({ workEmail: "lin@example.invalid", firstName: "Lin" });
    const refused = await cli(runPeople, ["start", "onboarding", "--id", String(planned.id)]);
    expect(refused).toMatchObject({ code: 1, err: "Choose an access profile before onboarding.\n" });
    const [unchanged] = await getDb().select().from(people).where(eq(people.id, planned.id));
    expect(unchanged!.status).toBe("planned");

    const wrong = await cli(runPeople, ["start", "promotion", "--id", String(person.id)]);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain("Name a workflow: onboarding, access_update, offboarding.");
  });
});
