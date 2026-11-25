import { and, eq, type SQL } from "drizzle-orm";
import { addDays, today } from "../core/time";
import {
  accessProfiles,
  connections,
  people,
  profileGrants,
  providerGroups,
  teamGroups,
  teams,
  users,
} from "../db/schema";
import { q } from "../db/tx";

/** Demo data for development and screenshots: a manual app, profiles, teams and people. */
export async function seedDemo(adminEmail: string): Promise<void> {
  await q()
    .insert(users)
    .values({ email: adminEmail, role: "admin", displayName: "Demo Admin" })
    .onConflictDoNothing();
  const figma = await getOrCreate(connections, eq(connections.name, "Figma"), {
    adapter: "manual",
    name: "Figma",
    enabled: true,
    mode: "manual",
    settings: { app_name: "Figma", instructions: "Assign an editor seat." },
  });
  const design = await getOrCreate(
    providerGroups,
    and(eq(providerGroups.connectionId, figma.id), eq(providerGroups.externalId, "manual:design")),
    { connectionId: figma.id, externalId: "manual:design", name: "Design", manual: true },
  );
  const staff = await getOrCreate(accessProfiles, eq(accessProfiles.name, "Staff"), {
    name: "Staff",
    description: "Employees and interns",
    defaultFor: ["employee", "intern"],
  });
  const volunteers = await getOrCreate(accessProfiles, eq(accessProfiles.name, "Volunteers"), {
    name: "Volunteers",
    description: "Volunteers",
    defaultFor: ["volunteer"],
  });
  await q()
    .insert(profileGrants)
    .values({ profileId: staff.id, connectionId: figma.id })
    .onConflictDoNothing();
  const product = await getOrCreate(teams, eq(teams.name, "Product"), {
    name: "Product",
    description: "Product and design",
  });
  await q()
    .insert(teamGroups)
    .values({ teamId: product.id, providerGroupId: design.id })
    .onConflictDoNothing();
  await getOrCreate(teams, eq(teams.name, "Operations"), { name: "Operations" });
  const day = today();
  const list = [
    ["Ada", "Lovelace", "employee", staff.id, product.id, addDays(day, -400), null],
    ["Grace", "Hopper", "employee", staff.id, product.id, addDays(day, 5), null],
    ["Alan", "Turing", "intern", staff.id, null, addDays(day, -60), addDays(day, 12)],
    ["Katherine", "Johnson", "volunteer", volunteers.id, null, addDays(day, 20), null],
  ] as const;
  for (const [first, last, type, profile, team, start, end] of list) {
    const workEmail = `${first.toLowerCase()}.${last.toLowerCase()}@example.invalid`;
    await getOrCreate(people, eq(people.workEmail, workEmail), {
      firstName: first,
      lastName: last,
      workEmail,
      personType: type,
      accessProfileId: profile,
      teamId: team,
      startDate: start,
      endDate: end,
      personalEmail: `${first.toLowerCase()}@personal.example.invalid`,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any table of the schema
async function getOrCreate<T extends Record<string, any>>(table: any, where: SQL | undefined, values: T) {
  const [existing] = (await q().select().from(table).where(where).limit(1)) as { id: number }[];
  if (existing) return existing;
  const [created] = (await q().insert(table).values(values).returning()) as { id: number }[];
  return created!;
}
