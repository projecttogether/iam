import { asc, eq, ne } from "drizzle-orm";
import { personInputSchema, WORKFLOW_KINDS } from "@iam/shared/api/iam";
import { WORKFLOW_KIND_LABELS } from "@iam/shared/labels";
import { accessProfiles, people, teams, type WorkflowKind } from "../db/schema";
import { q } from "../db/tx";
import { operator } from "../engine/audit";
import { LifecycleError, startWorkflow } from "../engine/lifecycle";
import { fullName } from "../engine/people";
import { AppError, parseWith } from "../http/errors";
import { addPerson, cleanPerson, personOr404, updatePerson } from "../modules/people";
import { idOption, json, parseArgs, readJsonBody, run, UsageError, type Io } from "./command";

/**
 * `cli people`: what an admin does on the People pages (add, edit, start a
 * workflow), through the same functions as their routes, as the operator
 * with an admin's rights (docs/deployment.md, "Settings from the command
 * line").
 */

const VERBS = ["list", "show", "apply", "start"];

/** A 404 with what was not found, instead of the page's bare "Not found". */
async function found<T>(id: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found")
      throw new AppError(404, "not_found", `No person has the ID ${id}.`);
    throw error;
  }
}

/** Everyone not archived, with team and access profile by name. */
async function rows() {
  const selected = await q()
    .select({ person: people, team: teams.name, profile: accessProfiles.name })
    .from(people)
    .leftJoin(teams, eq(teams.id, people.teamId))
    .leftJoin(accessProfiles, eq(accessProfiles.id, people.accessProfileId))
    .where(ne(people.status, "archived"))
    .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id));
  return selected.map(({ person, team, profile }) => ({
    id: person.id,
    name: fullName(person),
    workEmail: person.workEmail,
    personType: person.personType,
    status: person.status,
    team,
    accessProfile: profile,
    startDate: person.startDate,
    endDate: person.endDate,
  }));
}

/** The edit form of a person: the body for `apply --id`. */
async function personForm(id: number) {
  const person = await found(id, () => personOr404(id));
  return {
    id: person.id,
    status: person.status,
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
    startDate: person.startDate ?? "",
    endDate: person.endDate ?? "",
    notes: person.notes,
  };
}

async function list(args: string[], io: Io) {
  const parsed = parseArgs(args, { positionals: 0, flags: ["--json"] });
  const all = await rows();
  if (parsed.flags.has("--json")) {
    io.out(json(all));
    return;
  }
  if (all.length === 0) {
    io.out("No people.\n");
    return;
  }
  const labels = all.map((row) => `--id ${row.id}`);
  const width = Math.max(...labels.map((label) => label.length));
  io.out(
    all
      .map(
        (row, index) =>
          `${labels[index]!.padEnd(width)}  ${row.name}; ${row.workEmail ?? "no work email"}; ${row.personType}; ` +
          `${row.status}; team: ${row.team ?? "none"}; profile: ${row.accessProfile ?? "none"}\n`,
      )
      .join(""),
  );
}

async function apply(args: string[], io: Io) {
  const id = idOption(parseArgs(args, { positionals: 0, options: ["--id"] }), false);
  const actor = operator(`cli people apply${id === undefined ? "" : ` --id ${id}`}`);
  const input = parseWith(personInputSchema, await readJsonBody(io));
  if (id === undefined) {
    const person = await addPerson(await cleanPerson(input, null), actor);
    io.err(`Added ${fullName(person)}. ID: ${person.id}\n`);
    io.out(json(await personForm(person.id)));
    return;
  }
  const { message } = await found(id, () => updatePerson(id, input, actor));
  io.err(`${message}\n`);
  io.out(json(await personForm(id)));
}

/** Starts a workflow as the person's page does: onboarding, access_update or offboarding. */
async function start(args: string[], io: Io) {
  const parsed = parseArgs(args, { positionals: 1, options: ["--id"] });
  const kind = parsed.positionals[0];
  if (kind === undefined || !(WORKFLOW_KINDS as string[]).includes(kind)) {
    throw new UsageError(`Name a workflow: ${WORKFLOW_KINDS.join(", ")}.`);
  }
  const id = idOption(parsed, true)!;
  await found(id, () => personOr404(id));
  try {
    const workflow = await startWorkflow(id, kind as WorkflowKind, {
      actor: operator(`cli people start ${kind} --id ${id}`),
    });
    io.err(`Started ${WORKFLOW_KIND_LABELS[workflow.kind].toLowerCase()}. Workflow ID: ${workflow.id}\n`);
    io.out(json({ workflowId: workflow.id, kind: workflow.kind, status: workflow.status }));
  } catch (error) {
    if (error instanceof LifecycleError) throw new AppError(409, "lifecycle", error.message);
    throw error;
  }
}

export function runPeople(args: string[], io: Io): Promise<number> {
  return run(io, async () => {
    const [verb, ...rest] = args;
    switch (verb) {
      case "list":
        return list(rest, io);
      case "show": {
        const id = idOption(parseArgs(rest, { positionals: 0, options: ["--id"] }), true)!;
        io.out(json(await personForm(id)));
        return;
      }
      case "apply":
        return apply(rest, io);
      case "start":
        return start(rest, io);
      default:
        throw new UsageError(
          verb === undefined
            ? `Name a command: ${VERBS.join(", ")}.`
            : `Unknown command (not shown). Commands: ${VERBS.join(", ")}.`,
        );
    }
  });
}
