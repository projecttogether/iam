import { and, asc, eq, inArray } from "drizzle-orm";
import {
  connections,
  profileGrantGroups,
  profileGrants,
  providerGroups,
  teamGroups,
  type Connection,
  type DesiredSnapshot,
  type Person,
  type ProviderGroup,
} from "../db/schema";
import { q } from "../db/tx";
import { isProvisioning } from "./connections";
import { hasAccess } from "./people";

/**
 * Desired access: which accounts and groups a person should have.
 *
 * Access comes from two places. A person's access profile grants an account
 * at each of its connections, with groups. A person's team adds its groups,
 * but only at connections where the profile grants an account. People
 * without access (planned, offboarding, offboarded, archived) should have
 * nothing.
 *
 * Managed groups are all groups any profile or team references. The app
 * adds and removes only managed groups; other memberships in a connected app
 * are left alone.
 */

export class Grant {
  readonly groups = new Map<string, ProviderGroup>();
  /** Why each group applies: "profile" or "team". */
  readonly reasons = new Map<string, Set<string>>();

  constructor(readonly connection: Connection) {}

  add(group: ProviderGroup, reason: string): void {
    this.groups.set(group.externalId, group);
    const reasons = this.reasons.get(group.externalId) ?? new Set<string>();
    reasons.add(reason);
    this.reasons.set(group.externalId, reasons);
  }

  get groupIds(): string[] {
    return [...this.groups.keys()].sort();
  }
}

/** The label of a group: its path, or its name. */
export function groupLabel(group: Pick<ProviderGroup, "path" | "name">): string {
  return group.path || group.name;
}

export async function provisioningConnections(
  options: { includeDisabled?: boolean } = {},
): Promise<Connection[]> {
  const rows = await q()
    .select()
    .from(connections)
    .where(options.includeDisabled ? undefined : eq(connections.enabled, true))
    .orderBy(asc(connections.name));
  return rows.filter((connection) => isProvisioning(connection));
}

/**
 * What the person's profile and team grant, regardless of status. Turned-off
 * connections count only when asked for (offboarding).
 */
export async function entitledAccess(
  person: Pick<Person, "accessProfileId" | "teamId">,
  options: { includeDisabled?: boolean } = {},
): Promise<Map<number, Grant>> {
  const grants = new Map<number, Grant>();
  if (person.accessProfileId === null) return grants;
  const rows = await q()
    .select({ grantId: profileGrants.id, connection: connections })
    .from(profileGrants)
    .innerJoin(connections, eq(connections.id, profileGrants.connectionId))
    .where(
      and(
        eq(profileGrants.profileId, person.accessProfileId),
        options.includeDisabled ? undefined : eq(connections.enabled, true),
      ),
    )
    .orderBy(asc(connections.name), asc(profileGrants.id));
  const grantIds = rows.map((row) => row.grantId);
  const groups =
    grantIds.length === 0
      ? []
      : await q()
          .select({ grantId: profileGrantGroups.profileGrantId, group: providerGroups })
          .from(profileGrantGroups)
          .innerJoin(providerGroups, eq(providerGroups.id, profileGrantGroups.providerGroupId))
          .where(inArray(profileGrantGroups.profileGrantId, grantIds))
          .orderBy(asc(providerGroups.path), asc(providerGroups.name), asc(providerGroups.id));
  for (const row of rows) {
    if (!isProvisioning(row.connection)) continue;
    const grant = new Grant(row.connection);
    for (const item of groups) {
      if (item.grantId === row.grantId && !item.group.missing) grant.add(item.group, "profile");
    }
    grants.set(row.connection.id, grant);
  }
  if (person.teamId !== null) {
    const teamRows = await q()
      .select({ group: providerGroups })
      .from(teamGroups)
      .innerJoin(providerGroups, eq(providerGroups.id, teamGroups.providerGroupId))
      .where(and(eq(teamGroups.teamId, person.teamId), eq(providerGroups.missing, false)))
      .orderBy(asc(providerGroups.path), asc(providerGroups.name), asc(providerGroups.id));
    for (const { group } of teamRows) grants.get(group.connectionId)?.add(group, "team");
  }
  return grants;
}

export async function desiredAccess(
  person: Pick<Person, "status" | "accessProfileId" | "teamId">,
): Promise<Map<number, Grant>> {
  if (!hasAccess(person)) return new Map();
  return entitledAccess(person);
}

/** The groups of the connection that any profile or team references. */
export async function managedGroupIds(connectionId: number): Promise<Set<string>> {
  const fromProfiles = await q()
    .selectDistinct({ externalId: providerGroups.externalId })
    .from(providerGroups)
    .innerJoin(profileGrantGroups, eq(profileGrantGroups.providerGroupId, providerGroups.id))
    .where(eq(providerGroups.connectionId, connectionId));
  const fromTeams = await q()
    .selectDistinct({ externalId: providerGroups.externalId })
    .from(providerGroups)
    .innerJoin(teamGroups, eq(teamGroups.providerGroupId, providerGroups.id))
    .where(eq(providerGroups.connectionId, connectionId));
  return new Set([...fromProfiles, ...fromTeams].map((row) => row.externalId));
}

/** The JSON form of desired access a workflow keeps. */
export async function snapshot(
  person: Pick<Person, "status" | "accessProfileId" | "teamId">,
): Promise<DesiredSnapshot> {
  const result: DesiredSnapshot = {};
  for (const [connectionId, grant] of await desiredAccess(person)) {
    result[String(connectionId)] = {
      connection: grant.connection.name,
      groups: grant.groupIds,
      group_names: Object.fromEntries([...grant.groups].map(([id, group]) => [id, groupLabel(group)])),
    };
  }
  return result;
}
