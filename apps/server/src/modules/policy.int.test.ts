import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import {
  accessProfiles,
  profileGrantGroups,
  profileGrants,
  providerGroups,
  teamGroups,
  teams,
} from "../db/schema";
import { makeConnection, makeGroups, makeProfile, makeUser, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

/** Port of tests/test_views.py: the access profile and team forms. */

async function grantedGroups(profileId: number): Promise<string[]> {
  const rows = await getDb()
    .select({ externalId: providerGroups.externalId })
    .from(profileGrants)
    .innerJoin(profileGrantGroups, eq(profileGrantGroups.profileGrantId, profileGrants.id))
    .innerJoin(providerGroups, eq(providerGroups.id, profileGrantGroups.providerGroupId))
    .where(eq(profileGrants.profileId, profileId));
  return rows.map((row) => row.externalId).sort();
}

describe("teams and access profiles", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("saves the grants and groups of a profile", async () => {
    const admin = await makeUser("admin");
    const fake = await makeConnection();
    const groups = await makeGroups(fake);
    const created = await request("POST", "/api/v1/profiles", {
      user: admin,
      body: {
        name: "Engineers",
        description: "",
        defaultFor: ["intern"],
        grants: [{ connectionId: fake.id, groupIds: [groups["g-eng"]!.id, groups["g-ops"]!.id] }],
      },
    });
    expect(created.status).toBe(201);
    const [profile] = await getDb().select().from(accessProfiles).where(eq(accessProfiles.name, "Engineers"));
    expect(await grantedGroups(profile!.id)).toEqual(["g-eng", "g-ops"]);
    const saved = await request("PUT", `/api/v1/profiles/${profile!.id}`, {
      user: admin,
      body: { name: "Engineers", description: "", defaultFor: [], grants: [] },
    });
    expect(saved.status).toBe(200);
    expect(
      await getDb().select().from(profileGrants).where(eq(profileGrants.profileId, profile!.id)),
    ).toEqual([]);
  });

  it("keeps one default profile per person type", async () => {
    const admin = await makeUser("admin");
    const fake = await makeConnection();
    const groups = await makeGroups(fake);
    await makeProfile(fake, [groups["g-staff"]!]);
    const response = await request("POST", "/api/v1/profiles", {
      user: admin,
      body: { name: "Other", description: "", defaultFor: ["employee"], grants: [] },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.defaultFor).toContain("already the default");
    expect(await getDb().select().from(accessProfiles).where(eq(accessProfiles.name, "Other"))).toEqual([]);
  });

  it("sets the groups of a team", async () => {
    const admin = await makeUser("admin");
    const groups = await makeGroups(await makeConnection());
    const response = await request("POST", "/api/v1/teams", {
      user: admin,
      body: { name: "Ops", description: "", groupIds: [groups["g-ops"]!.id] },
    });
    expect(response.status).toBe(201);
    const rows = await getDb()
      .select({ externalId: providerGroups.externalId })
      .from(teams)
      .innerJoin(teamGroups, eq(teamGroups.teamId, teams.id))
      .innerJoin(providerGroups, eq(providerGroups.id, teamGroups.providerGroupId))
      .where(eq(teams.name, "Ops"));
    expect(rows.map((row) => row.externalId)).toEqual(["g-ops"]);
  });
});
