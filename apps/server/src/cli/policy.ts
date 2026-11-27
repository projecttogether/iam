import { profileInputSchema, teamInputSchema } from "@iam/shared/api/iam";
import { PERSON_TYPE_LABELS } from "@iam/shared/labels";
import { operator } from "../engine/audit";
import { AppError, parseWith } from "../http/errors";
import {
  deleteProfile,
  deleteTeam,
  groupConnections,
  profileDetail,
  profileList,
  saveProfile,
  saveTeam,
  teamDetail,
  teamList,
} from "../modules/policy";
import { idOption, json, parseArgs, readJsonBody, run, UsageError, type Io } from "./command";

/**
 * `cli groups`, `cli teams` and `cli profiles`: the policy an admin builds
 * on the Teams and Access profiles pages, through the same functions as
 * their routes, as the operator (docs/deployment.md, "Settings from the
 * command line"). Bodies name groups by the IDs that `cli groups list` shows.
 */

/** A 404 with what was not found, instead of the page's bare "Not found". */
async function found<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") throw new AppError(404, "not_found", what);
    throw error;
  }
}

/** Lines of a table: the first column padded to the widest. */
function table(rows: [string, string][]): string {
  const width = Math.max(0, ...rows.map(([first]) => first.length));
  return rows.map(([first, rest]) => `${first.padEnd(width)}  ${rest}\n`).join("");
}

/**
 * The groups the forms offer. A group the last import no longer found is
 * dropped on save, as the forms drop it, so it cannot come back granted.
 */
async function choosable(): Promise<Set<number>> {
  return new Set(
    (await groupConnections()).flatMap((connection) => connection.groups.map((group) => group.id)),
  );
}

function unknownVerb(verb: string | undefined, verbs: string[]): never {
  throw new UsageError(
    verb === undefined
      ? `Name a command: ${verbs.join(", ")}.`
      : `Unknown command (not shown). Commands: ${verbs.join(", ")}.`,
  );
}

export async function runGroups(args: string[], io: Io): Promise<number> {
  return run(io, async () => {
    const [verb, ...rest] = args;
    if (verb !== "list") unknownVerb(verb, ["list"]);
    const parsed = parseArgs(rest, { positionals: 0, flags: ["--json"] });
    const connections = await groupConnections();
    if (parsed.flags.has("--json")) {
      io.out(json(connections));
      return;
    }
    const rows: [string, string][] = [];
    for (const connection of connections) {
      if (!connection.supportsGroups) continue;
      for (const group of connection.groups)
        rows.push([String(group.id), `${connection.name}: ${group.label}`]);
    }
    io.out(rows.length > 0 ? table(rows) : "No groups. Import them on a connection's page first.\n");
  });
}

/** A team's edit form: the body for `apply`, with the groups' labels to read. */
async function teamForm(id: number) {
  const team = await found(`No team has the ID ${id}.`, () => teamDetail(id));
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    groupIds: team.groupIds,
    groups: team.groups.map((group) => `${group.connection}: ${group.label}`),
    members: team.members.length,
  };
}

export async function runTeams(args: string[], io: Io): Promise<number> {
  return run(io, async () => {
    const [verb, ...rest] = args;
    switch (verb) {
      case "list": {
        const parsed = parseArgs(rest, { positionals: 0, flags: ["--json"] });
        const rows = await teamList();
        if (parsed.flags.has("--json")) io.out(json(rows));
        else
          io.out(
            rows.length === 0
              ? "No teams.\n"
              : table(
                  rows.map((row) => [
                    `--id ${row.id}`,
                    `${row.name}; ${row.memberCount} members; ${row.groups.length} groups`,
                  ]),
                ),
          );
        return;
      }
      case "show": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), true)!;
        io.out(json(await teamForm(id)));
        return;
      }
      case "apply": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), false);
        const actor = operator(`cli teams apply${id === undefined ? "" : ` --id ${id}`}`);
        const input = parseWith(teamInputSchema, await readJsonBody(io));
        if (id !== undefined) await found(`No team has the ID ${id}.`, () => teamDetail(id));
        const groups = await choosable();
        input.groupIds = input.groupIds.filter((groupId) => groups.has(groupId));
        const saved = await saveTeam(id ?? null, input, actor);
        io.err(`Saved team ${input.name}. ID: ${saved}\n`);
        io.out(json(await teamForm(saved)));
        return;
      }
      case "remove": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), true)!;
        const message = await found(`No team has the ID ${id}.`, () =>
          deleteTeam(id, operator(`cli teams remove --id ${id}`)),
        );
        io.err(`${message}\n`);
        return;
      }
      default:
        unknownVerb(verb, ["list", "show", "apply", "remove"]);
    }
  });
}

/** A profile's edit form: the body for `apply`, with the groups' labels to read. */
async function profileForm(id: number) {
  const profile = await found(`No access profile has the ID ${id}.`, () => profileDetail(id));
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    defaultFor: profile.defaultFor,
    grants: profile.grants.map((grant) => ({
      connectionId: grant.connection.id,
      connection: grant.connection.name,
      groupIds: grant.groups.map((group) => group.id),
      groups: grant.groups.map((group) => group.label),
    })),
  };
}

export async function runProfiles(args: string[], io: Io): Promise<number> {
  return run(io, async () => {
    const [verb, ...rest] = args;
    switch (verb) {
      case "list": {
        const parsed = parseArgs(rest, { positionals: 0, flags: ["--json"] });
        const rows = await profileList();
        if (parsed.flags.has("--json")) io.out(json(rows));
        else
          io.out(
            rows.length === 0
              ? "No access profiles.\n"
              : table(
                  rows.map((row) => {
                    const defaults = row.defaultFor.map((type) => PERSON_TYPE_LABELS[type]).join(", ");
                    return [
                      `--id ${row.id}`,
                      `${row.name}; ${row.peopleCount} people; ${row.grants.map((grant) => grant.connection).join(", ") || "no accounts"}` +
                        (defaults ? `; default for ${defaults}` : ""),
                    ];
                  }),
                ),
          );
        return;
      }
      case "show": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), true)!;
        io.out(json(await profileForm(id)));
        return;
      }
      case "apply": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), false);
        const actor = operator(`cli profiles apply${id === undefined ? "" : ` --id ${id}`}`);
        const input = parseWith(profileInputSchema, await readJsonBody(io));
        if (id !== undefined) await found(`No access profile has the ID ${id}.`, () => profileDetail(id));
        const groups = await choosable();
        for (const grant of input.grants)
          grant.groupIds = grant.groupIds.filter((groupId) => groups.has(groupId));
        const saved = await saveProfile(id ?? null, input, actor);
        io.err(`Saved ${input.name}. ID: ${saved}. Start access updates for its people to apply changes.\n`);
        io.out(json(await profileForm(saved)));
        return;
      }
      case "remove": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), true)!;
        const message = await found(`No access profile has the ID ${id}.`, () =>
          deleteProfile(id, operator(`cli profiles remove --id ${id}`)),
        );
        io.err(`${message}\n`);
        return;
      }
      default:
        unknownVerb(verb, ["list", "show", "apply", "remove"]);
    }
  });
}
