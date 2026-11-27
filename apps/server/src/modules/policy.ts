import { Hono } from "hono";
import { and, asc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  profileInputSchema,
  teamInputSchema,
  type GroupConnection,
  type ProfileDetail,
  type ProfileRow,
  type TeamDetail,
  type TeamRow,
} from "@iam/shared/api/iam";
import { PERSON_TYPE_LABELS, type PersonType } from "@iam/shared/labels";
import {
  accessProfiles,
  connections,
  people,
  profileGrantGroups,
  profileGrants,
  providerGroups,
  teamGroups,
  teams,
  type ProviderGroup,
  type User,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, requireRole } from "../http/middleware";
import { AppError, notFound, validationError } from "../http/errors";
import { record, type Operator } from "../engine/audit";
import { adapterClassOf, isProvisioning, supportsGroups } from "../engine/connections";
import { fullName } from "../engine/people";
import { groupLabel } from "../engine/policy";

/**
 * Teams and access profiles: the policy that decides desired access. The
 * routes and the operator commands (`cli teams`, `cli profiles`, `cli
 * groups`) call the same functions.
 */
const router = new Hono<AppEnv>();

/** Who saves a team or profile: an admin, or the operator. */
type Actor = Pick<User, "id" | "email"> | Operator;

/** Account connections with their selectable groups. */
export async function groupConnections(): Promise<GroupConnection[]> {
  const rows = (await q().select().from(connections).orderBy(asc(connections.name))).filter(isProvisioning);
  const groups =
    rows.length === 0
      ? []
      : await q()
          .select()
          .from(providerGroups)
          .where(
            and(
              inArray(
                providerGroups.connectionId,
                rows.map((row) => row.id),
              ),
              eq(providerGroups.missing, false),
            ),
          )
          .orderBy(asc(providerGroups.path), asc(providerGroups.name), asc(providerGroups.id));
  return rows.map((connection) => ({
    id: connection.id,
    name: connection.name,
    enabled: connection.enabled,
    mode: connection.mode,
    groupLabel: adapterClassOf(connection)?.groupLabel ?? "Groups",
    supportsGroups: supportsGroups(connection),
    groups: groups
      .filter((group) => group.connectionId === connection.id)
      .map((group) => ({ id: group.id, label: groupLabel(group) })),
  }));
}

/** The choices of the team and profile forms, which only admins use (as in the Django version). */
router.get("/group-connections", async (c) => {
  requireRole(c, "admin");
  return c.json(await groupConnections());
});

async function groupsById(ids: number[]): Promise<ProviderGroup[]> {
  if (ids.length === 0) return [];
  return q()
    .select()
    .from(providerGroups)
    .where(inArray(providerGroups.id, [...new Set(ids)]));
}

const labelsOf = async (rows: { connectionId: number; group: ProviderGroup }[]) => {
  const names = new Map(
    (await q().select({ id: connections.id, name: connections.name }).from(connections)).map((row) => [
      row.id,
      row.name,
    ]),
  );
  return rows.map((row) => ({ label: groupLabel(row.group), connection: names.get(row.connectionId) ?? "" }));
};

// -- teams --------------------------------------------------------------------------

export async function teamList(): Promise<TeamRow[]> {
  const rows = await q()
    .select({
      team: teams,
      memberCount: sql<number>`(select count(*) from "iam_person" as member where member.team_id = "iam_team"."id")`,
    })
    .from(teams)
    .orderBy(asc(teams.name));
  const groups = await q()
    .select({ teamId: teamGroups.teamId, group: providerGroups })
    .from(teamGroups)
    .innerJoin(providerGroups, eq(providerGroups.id, teamGroups.providerGroupId))
    .orderBy(asc(providerGroups.path), asc(providerGroups.name));
  const body: TeamRow[] = [];
  for (const { team, memberCount } of rows) {
    const own = groups.filter((row) => row.teamId === team.id);
    body.push({
      id: team.id,
      name: team.name,
      description: team.description,
      memberCount: Number(memberCount),
      groups: await labelsOf(own.map((row) => ({ connectionId: row.group.connectionId, group: row.group }))),
    });
  }
  return body;
}

router.get("/teams", async (c) => {
  requireRole(c, "viewer");
  return c.json(await teamList());
});

export async function teamDetail(id: number): Promise<TeamDetail> {
  const [team] = await q().select().from(teams).where(eq(teams.id, id));
  if (!team) throw notFound();
  const members = await q()
    .select({ person: people, profile: accessProfiles.name })
    .from(people)
    .leftJoin(accessProfiles, eq(accessProfiles.id, people.accessProfileId))
    .where(and(eq(people.teamId, team.id), ne(people.status, "archived")))
    .orderBy(asc(people.lastName), asc(people.firstName));
  const groups = await q()
    .select({ group: providerGroups, connection: connections.name })
    .from(teamGroups)
    .innerJoin(providerGroups, eq(providerGroups.id, teamGroups.providerGroupId))
    .innerJoin(connections, eq(connections.id, providerGroups.connectionId))
    .where(eq(teamGroups.teamId, team.id))
    .orderBy(asc(connections.name), asc(providerGroups.path), asc(providerGroups.name));
  const body: TeamDetail = {
    id: team.id,
    name: team.name,
    description: team.description,
    members: members.map(({ person, profile }) => ({
      id: person.id,
      name: fullName(person),
      status: person.status,
      accessProfile: profile,
    })),
    groups: groups.map(({ group, connection }) => ({
      id: group.id,
      label: groupLabel(group),
      connection,
      missing: group.missing,
    })),
    groupIds: groups.map(({ group }) => group.id),
  };
  return body;
}

router.get("/teams/:id", async (c) => {
  requireRole(c, "viewer");
  return c.json(await teamDetail(idParam(c)));
});

export async function saveTeam(
  id: number | null,
  input: ReturnType<typeof teamInputSchema.parse>,
  actor: Actor,
): Promise<number> {
  const taken = await q()
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.name, input.name), id ? ne(teams.id, id) : undefined))
    .limit(1);
  if (taken.length > 0) throw validationError({ name: "Team with this Name already exists." });
  return atomic(async () => {
    let teamId = id;
    if (teamId === null) {
      const [created] = await q()
        .insert(teams)
        .values({ name: input.name, description: input.description })
        .returning();
      teamId = created!.id;
    } else {
      await q()
        .update(teams)
        .set({ name: input.name, description: input.description })
        .where(eq(teams.id, teamId));
    }
    const groups = await groupsById(input.groupIds);
    await q().delete(teamGroups).where(eq(teamGroups.teamId, teamId));
    if (groups.length > 0) {
      await q()
        .insert(teamGroups)
        .values(groups.map((group) => ({ teamId: teamId!, providerGroupId: group.id })));
    }
    const sorted = [...groups].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b)));
    await record("team.saved", `Saved team ${input.name}`, {
      actor,
      target: { type: "team", id: teamId },
      details: { groups: sorted.map(groupLabel) },
    });
    return teamId;
  });
}

router.post("/teams", async (c) => {
  const user = requireRole(c, "admin");
  const input = await jsonBody(c, teamInputSchema);
  const id = await saveTeam(null, input, user);
  return c.json({ id, message: `Saved team ${input.name}.` }, 201);
});

router.put("/teams/:id", async (c) => {
  const user = requireRole(c, "admin");
  const id = idParam(c);
  const [team] = await q().select().from(teams).where(eq(teams.id, id));
  if (!team) throw notFound();
  const input = await jsonBody(c, teamInputSchema);
  await saveTeam(id, input, user);
  return c.json({ id, message: `Saved team ${input.name}.` });
});

/** Deletes a team; its members keep their access profile and lose its groups at their next access update. */
export async function deleteTeam(id: number, actor: Actor): Promise<string> {
  const [team] = await q().select().from(teams).where(eq(teams.id, id));
  if (!team) throw notFound();
  await atomic(async () => {
    await q().delete(teams).where(eq(teams.id, team.id));
    await record("team.deleted", `Deleted team ${team.name}`, { actor });
  });
  return `Deleted team ${team.name}.`;
}

router.delete("/teams/:id", async (c) => {
  const user = requireRole(c, "admin");
  return c.json({ message: await deleteTeam(idParam(c), user) });
});

// -- access profiles --------------------------------------------------------------

async function grantsOf(profileIds: number[]) {
  if (profileIds.length === 0) return [];
  const grants = await q()
    .select({ grant: profileGrants, connection: connections })
    .from(profileGrants)
    .innerJoin(connections, eq(connections.id, profileGrants.connectionId))
    .where(inArray(profileGrants.profileId, profileIds))
    .orderBy(asc(connections.name));
  const groups =
    grants.length === 0
      ? []
      : await q()
          .select({ grantId: profileGrantGroups.profileGrantId, group: providerGroups })
          .from(profileGrantGroups)
          .innerJoin(providerGroups, eq(providerGroups.id, profileGrantGroups.providerGroupId))
          .where(
            inArray(
              profileGrantGroups.profileGrantId,
              grants.map((row) => row.grant.id),
            ),
          )
          .orderBy(asc(providerGroups.path), asc(providerGroups.name));
  return grants.map((row) => ({
    ...row,
    groups: groups.filter((item) => item.grantId === row.grant.id).map((item) => item.group),
  }));
}

export async function profileList(): Promise<ProfileRow[]> {
  const rows = await q()
    .select({
      profile: accessProfiles,
      peopleCount: sql<number>`(select count(*) from "iam_person" as holder where holder.access_profile_id = "iam_accessprofile"."id")`,
    })
    .from(accessProfiles)
    .orderBy(asc(accessProfiles.name));
  const grants = await grantsOf(rows.map((row) => row.profile.id));
  const body: ProfileRow[] = rows.map(({ profile, peopleCount }) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    defaultFor: profile.defaultFor as PersonType[],
    peopleCount: Number(peopleCount),
    grants: grants
      .filter((row) => row.grant.profileId === profile.id)
      .map((row) => ({ connection: row.connection.name, groups: row.groups.map(groupLabel) })),
  }));
  return body;
}

router.get("/profiles", async (c) => {
  requireRole(c, "viewer");
  return c.json(await profileList());
});

export async function profileDetail(id: number): Promise<ProfileDetail> {
  const [profile] = await q().select().from(accessProfiles).where(eq(accessProfiles.id, id));
  if (!profile) throw notFound();
  const members = await q()
    .select({ person: people, team: teams.name })
    .from(people)
    .leftJoin(teams, eq(teams.id, people.teamId))
    .where(and(eq(people.accessProfileId, profile.id), ne(people.status, "archived")))
    .orderBy(asc(people.lastName), asc(people.firstName))
    .limit(200);
  const body: ProfileDetail = {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    defaultFor: profile.defaultFor as PersonType[],
    grants: (await grantsOf([profile.id])).map((row) => ({
      connection: { id: row.connection.id, name: row.connection.name, enabled: row.connection.enabled },
      groups: row.groups.map((group) => ({ id: group.id, label: groupLabel(group), missing: group.missing })),
    })),
    people: members.map(({ person, team }) => ({
      id: person.id,
      name: fullName(person),
      status: person.status,
      team,
    })),
  };
  return body;
}

router.get("/profiles/:id", async (c) => {
  requireRole(c, "viewer");
  return c.json(await profileDetail(idParam(c)));
});

export async function saveProfile(
  id: number | null,
  input: ReturnType<typeof profileInputSchema.parse>,
  actor: Actor,
): Promise<number> {
  const errors: Record<string, string> = {};
  const taken = await q()
    .select({ id: accessProfiles.id })
    .from(accessProfiles)
    .where(and(eq(accessProfiles.name, input.name), id ? ne(accessProfiles.id, id) : undefined))
    .limit(1);
  if (taken.length > 0) errors.name = "Access profile with this Name already exists.";
  const others = await q()
    .select()
    .from(accessProfiles)
    .where(id ? ne(accessProfiles.id, id) : undefined)
    .orderBy(asc(accessProfiles.name));
  for (const other of others) {
    const overlap = input.defaultFor.filter((type) => (other.defaultFor ?? []).includes(type));
    if (overlap.length > 0) {
      const labels = [...new Set(overlap)]
        .sort()
        .map((type) => PERSON_TYPE_LABELS[type])
        .join(", ");
      errors.defaultFor = `${other.name} is already the default for ${labels}.`;
      break;
    }
  }
  if (Object.keys(errors).length > 0) throw validationError(errors);
  const accountConnections = (await q().select().from(connections)).filter(isProvisioning);
  const allowed = new Set(accountConnections.map((connection) => connection.id));
  const granted = new Map<number, number[]>();
  for (const grant of input.grants)
    if (allowed.has(grant.connectionId)) granted.set(grant.connectionId, grant.groupIds);
  return atomic(async () => {
    let profileId = id;
    const values = {
      name: input.name,
      description: input.description,
      defaultFor: [...new Set(input.defaultFor)],
    };
    if (profileId === null) {
      const [created] = await q().insert(accessProfiles).values(values).returning();
      profileId = created!.id;
    } else {
      await q().update(accessProfiles).set(values).where(eq(accessProfiles.id, profileId));
    }
    await q()
      .delete(profileGrants)
      .where(
        and(
          eq(profileGrants.profileId, profileId),
          granted.size > 0 ? notInArray(profileGrants.connectionId, [...granted.keys()]) : undefined,
        ),
      );
    for (const [connectionId, groupIds] of granted) {
      await q().insert(profileGrants).values({ profileId, connectionId }).onConflictDoNothing();
      const [grant] = await q()
        .select()
        .from(profileGrants)
        .where(and(eq(profileGrants.profileId, profileId), eq(profileGrants.connectionId, connectionId)));
      const groups = (await groupsById(groupIds)).filter((group) => group.connectionId === connectionId);
      await q().delete(profileGrantGroups).where(eq(profileGrantGroups.profileGrantId, grant!.id));
      if (groups.length > 0) {
        await q()
          .insert(profileGrantGroups)
          .values(groups.map((group) => ({ profileGrantId: grant!.id, providerGroupId: group.id })));
      }
    }
    const saved = await grantsOf([profileId]);
    await record("profile.saved", `Saved access profile ${input.name}`, {
      actor,
      target: { type: "accessprofile", id: profileId },
      details: {
        grants: Object.fromEntries(saved.map((row) => [row.connection.name, row.groups.map(groupLabel)])),
      },
    });
    return profileId;
  });
}

router.post("/profiles", async (c) => {
  const user = requireRole(c, "admin");
  const input = await jsonBody(c, profileInputSchema);
  const id = await saveProfile(null, input, user);
  return c.json(
    { id, message: `Saved ${input.name}. Start access updates for its people to apply changes.` },
    201,
  );
});

router.put("/profiles/:id", async (c) => {
  const user = requireRole(c, "admin");
  const id = idParam(c);
  const [profile] = await q().select().from(accessProfiles).where(eq(accessProfiles.id, id));
  if (!profile) throw notFound();
  const input = await jsonBody(c, profileInputSchema);
  await saveProfile(id, input, user);
  return c.json({
    id,
    message: `Saved ${input.name}. Start access updates for its people to apply changes.`,
  });
});

/** Deletes an access profile that nobody has. */
export async function deleteProfile(id: number, actor: Actor): Promise<string> {
  const [profile] = await q().select().from(accessProfiles).where(eq(accessProfiles.id, id));
  if (!profile) throw notFound();
  const assigned = await q()
    .select({ id: people.id })
    .from(people)
    .where(eq(people.accessProfileId, profile.id))
    .limit(1);
  if (assigned.length > 0)
    throw new AppError(409, "protected", `${profile.name} is still assigned to people.`);
  await atomic(async () => {
    await q().delete(accessProfiles).where(eq(accessProfiles.id, profile.id));
    await record("profile.deleted", `Deleted access profile ${profile.name}`, { actor });
  });
  return `Deleted access profile ${profile.name}.`;
}

router.delete("/profiles/:id", async (c) => {
  const user = requireRole(c, "admin");
  return c.json({ message: await deleteProfile(idParam(c), user) });
});

export default router;
