import { afterAll, beforeAll, beforeEach } from "vitest";
import {
  accessProfiles,
  connections,
  people,
  profileGrantGroups,
  profileGrants,
  providerGroups,
  teamGroups,
  teams,
  users,
  type AccessProfile,
  type Connection,
  type Person,
  type ProviderGroup,
  type Role,
  type Team,
  type User,
} from "../db/schema";
import { getDb } from "../db/client";
import { encryptSecrets } from "../engine/connections";
import { registerAdapterForTests } from "../adapters/registry";
import { overrideConfigForTests, config, type Config } from "../config";
import { FakeAdapter, resetFakeStore, type FakeStore } from "./fake-adapter";
import { resetDatabase } from "./helpers";

/**
 * The fixtures of the engine tests (port of tests/conftest.py): an empty
 * database before each test, the fake adapter registered, and builders for
 * the usual records. Call `useEngineFixtures()` at the top of a test file.
 */

export function useEngineFixtures() {
  let unregister: () => void;
  const original: Partial<Config> = {};
  beforeAll(() => {
    unregister = registerAdapterForTests(FakeAdapter as never);
    Object.assign(original, { READ_ONLY: config().READ_ONLY, isDevelopment: config().isDevelopment });
  });
  afterAll(() => unregister());
  beforeEach(async () => {
    overrideConfigForTests(original);
    await resetDatabase();
    resetFakeStore();
  });
}

export async function fakeStore(): Promise<FakeStore> {
  return resetFakeStore();
}

export async function makeConnection(
  values: Partial<typeof connections.$inferInsert> = {},
): Promise<Connection> {
  const [connection] = await getDb()
    .insert(connections)
    .values({
      adapter: "fake",
      name: "Fake app",
      enabled: true,
      settings: {},
      secretData: encryptSecrets({ token: "fake-token" }),
      ...values,
    })
    .returning();
  return connection!;
}

/** The fake connection's groups g-staff, g-eng, g-ops by external ID. */
export async function makeGroups(connection: Connection): Promise<Record<string, ProviderGroup>> {
  const result: Record<string, ProviderGroup> = {};
  for (const [id, name] of [
    ["g-staff", "Staff"],
    ["g-eng", "Engineering"],
    ["g-ops", "Operations"],
  ] as const) {
    const [group] = await getDb()
      .insert(providerGroups)
      .values({ connectionId: connection.id, externalId: id, name })
      .returning();
    result[id] = group!;
  }
  return result;
}

/** A profile "Staff" (default for employees) granting the connection with g-staff. */
export async function makeProfile(
  connection: Connection,
  groups: ProviderGroup[],
  values: Partial<typeof accessProfiles.$inferInsert> = {},
): Promise<AccessProfile> {
  const [profile] = await getDb()
    .insert(accessProfiles)
    .values({ name: "Staff", defaultFor: ["employee"], ...values })
    .returning();
  await grant(profile!, connection, groups);
  return profile!;
}

export async function grant(profile: AccessProfile, connection: Connection, groups: ProviderGroup[] = []) {
  const [row] = await getDb()
    .insert(profileGrants)
    .values({ profileId: profile.id, connectionId: connection.id })
    .returning();
  for (const group of groups) {
    await getDb().insert(profileGrantGroups).values({ profileGrantId: row!.id, providerGroupId: group.id });
  }
  return row!;
}

/** A team "Engineering" with the groups. */
export async function makeTeam(groups: ProviderGroup[], name = "Engineering"): Promise<Team> {
  const [team] = await getDb().insert(teams).values({ name }).returning();
  for (const group of groups)
    await getDb().insert(teamGroups).values({ teamId: team!.id, providerGroupId: group.id });
  return team!;
}

/** Ada Lovelace, planned, with the profile and team. */
export async function makePerson(values: Partial<typeof people.$inferInsert> = {}): Promise<Person> {
  const [person] = await getDb()
    .insert(people)
    .values({
      firstName: "Ada",
      lastName: "Lovelace",
      workEmail: "ada@example.invalid",
      personalEmail: "ada@personal.example.invalid",
      ...values,
    })
    .returning();
  return person!;
}

export async function makeUser(role: Role, email?: string, values: Partial<User> = {}): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ email: email ?? `${role}@example.invalid`, role, ...values })
    .returning();
  return user!;
}

/**
 * The usual setup of the Python tests: the fake connection, its groups, the
 * profile (g-staff), the team (g-eng) and Ada with both.
 */
export async function standardSetup() {
  const connection = await makeConnection();
  const groups = await makeGroups(connection);
  const profile = await makeProfile(connection, [groups["g-staff"]!]);
  const team = await makeTeam([groups["g-eng"]!]);
  const person = await makePerson({ accessProfileId: profile.id, teamId: team.id });
  return { connection, groups, profile, team, person };
}
