import { asc, eq } from "drizzle-orm";
import { connectionInputSchema, settingsInputSchema } from "@iam/shared/api/iam";
import { AdapterKind, type AdapterClass } from "../adapters/base";
import { adapterClasses, getAdapterClass } from "../adapters/registry";
import { appSettings, connections, type Connection } from "../db/schema";
import { q } from "../db/tx";
import { operator } from "../engine/audit";
import { adapterClassOf, kindOf } from "../engine/connections";
import { exclusive, SYNC_LOCK_ID } from "../engine/schedule";
import { compareAccounts, importGroups, importPeople } from "../engine/sync";
import { AppError, parseWith } from "../http/errors";
import {
  adapterInfo,
  connectionForm,
  connectionList,
  connectionOr404,
  createConnection,
  deleteConnection,
  editableConnection,
  newConnectionSchema,
  runAnswer,
  savedSecrets,
  testConnection,
  updateConnection,
} from "../modules/connections";
import { saveSettings, settingsView } from "../modules/settings";
import { idOption, json, parseArgs, readJsonBody, run, UsageError, type Io } from "./command";

/**
 * `cli settings`: what Admin › Settings (`app`) and Admin › Connections
 * (`connections`) set, through the same functions as their routes, as the
 * operator (docs/deployment.md, "Settings from the command line").
 */

export const SETTING_NAMES = ["app", "connections"] as const;
type SettingName = (typeof SETTING_NAMES)[number];

type Row = { name: SettingName; id: number | null; state: "set" | "not set" | "incomplete"; hints: string[] };

function settingName(value: string | undefined): SettingName {
  if (value === undefined) throw new UsageError(`Name a setting: ${SETTING_NAMES.join(", ")}.`);
  if (!(SETTING_NAMES as readonly string[]).includes(value)) {
    throw new UsageError(`Unknown setting (not shown). Settings: ${SETTING_NAMES.join(", ")}.`);
  }
  return value as SettingName;
}

/** A 404 with what was not found, instead of the page's bare "Not found". */
async function found<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") throw new AppError(404, "not_found", what);
    throw error;
  }
}

const onOff = (value: boolean) => (value ? "on" : "off");
const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** States and counts only: the values are in `show app`. */
async function appRow(): Promise<Row> {
  // Read without creating the row, unlike the page.
  const [row] = await q().select().from(appSettings).where(eq(appSettings.id, 1));
  if (!row) return { name: "app", id: null, state: "not set", hints: ["the defaults"] };
  const emails = row.notificationEmails.split(/\r\n|\r|\n/).filter((line) => line.trim()).length;
  return {
    name: "app",
    id: null,
    state: "set",
    hints: [
      `automatic onboarding ${onOff(row.automaticOnboarding)}`,
      `automatic offboarding ${onOff(row.automaticOffboarding)}`,
      `task emails: ${counted(emails, "address", "addresses")}`,
      `identity requests: ${counted(row.identityRequestTypes.length, "person type", "person types")}`,
    ],
  };
}

/** A connection's line: whether every required field and secret is saved, and hints as the page shows them. */
function connectionRow(connection: Connection): Row {
  const cls = adapterClassOf(connection);
  const hints = [`${connection.name} (${connection.adapter})`, onOff(connection.enabled)];
  if (!cls)
    return {
      name: "connections",
      id: connection.id,
      state: "incomplete",
      hints: [...hints, "unknown adapter"],
    };
  if (cls.supportsWrite && cls.kind === AdapterKind.PROVISIONING) hints.push(connection.mode);
  hints.push(`test: ${connection.status}`);
  const saved = savedSecrets(connection);
  let complete = true;
  for (const spec of cls.fields) {
    if (spec.kind === "secret") {
      hints.push(`${spec.label}: ${spec.name in saved ? "saved" : "not saved"}`);
      if (spec.required && !(spec.name in saved)) complete = false;
    } else if (spec.required && [undefined, null, ""].includes(connection.settings[spec.name] as never)) {
      complete = false;
    }
  }
  return { name: "connections", id: connection.id, state: complete ? "set" : "incomplete", hints };
}

async function list(asJson: boolean, io: Io) {
  const rows = [await appRow()];
  const saved = await q().select().from(connections).orderBy(asc(connections.name), asc(connections.id));
  if (saved.length === 0)
    rows.push({ name: "connections", id: null, state: "not set", hints: ["no connections"] });
  rows.push(...saved.map(connectionRow));
  if (asJson) {
    io.out(json(rows));
    return;
  }
  const labels = rows.map((row) => (row.id === null ? row.name : `${row.name} --id ${row.id}`));
  const width = Math.max(...labels.map((label) => label.length));
  io.out(
    rows
      .map(
        (row, index) => `${labels[index]!.padEnd(width)}  ${row.state.padEnd(10)}  ${row.hints.join("; ")}\n`,
      )
      .join(""),
  );
}

/** The edit form of a connection with its ID: what `apply --id` changes. */
async function showConnection(id: number) {
  const { connection, cls } = await found(`No connection has the ID ${id}.`, () => editableConnection(id));
  return { id, ...connectionForm(connection, cls) };
}

async function show(name: SettingName, id: number | undefined, adapter: string | undefined, io: Io) {
  if (name === "app") {
    if (id !== undefined || adapter !== undefined) throw new UsageError("app takes no --id or --adapter.");
    io.out(json(await settingsView()));
  } else if (adapter !== undefined) {
    if (id !== undefined) throw new UsageError("Give --id or --adapter, not both.");
    const cls = getAdapterClass(adapter);
    if (!cls) throw new AppError(404, "not_found", `Unknown adapter. ${adapterNames()}`);
    io.out(json(adapterInfo(cls)));
  } else {
    io.out(json(id === undefined ? await connectionList() : await showConnection(id)));
  }
}

export const adapterNames = () =>
  `Adapters: ${adapterClasses()
    .map((cls) => cls.slug)
    .join(", ")}.`;

/**
 * A refusal names a key under `secrets` only when it is a secret field of the
 * adapter: any other key of the body could be a secret pasted in its place.
 */
async function knownSecretKeys<T>(cls: AdapterClass | null, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AppError) || !error.fields) throw error;
    const known = new Set(
      (cls?.fields ?? []).filter((spec) => spec.kind === "secret").map((spec) => spec.name),
    );
    const fields = Object.fromEntries(
      Object.entries(error.fields).map(([key, message]) => [
        key.startsWith("secrets.") && !known.has(key.slice("secrets.".length)) ? "secrets.(not shown)" : key,
        message,
      ]),
    );
    throw new AppError(error.status, error.code, error.message, fields, error.extra);
  }
}

/** Saves the body on stdin as the page does, then prints what `show` prints. */
async function apply(name: SettingName, id: number | undefined, command: string, io: Io) {
  const actor = operator(command);
  if (name === "app") {
    if (id !== undefined) throw new UsageError("app takes no --id.");
    const body = await readJsonBody(io);
    const { message, ...settings } = await saveSettings(actor, parseWith(settingsInputSchema, body));
    io.err(`${message}\n`);
    io.out(json(settings));
  } else if (id === undefined) {
    const body = await readJsonBody(io);
    // The adapter as the schema reads it (trimmed), for the names of its secret fields.
    const slug = newConnectionSchema.shape.adapter.safeParse((body as { adapter?: unknown } | null)?.adapter);
    const input = await knownSecretKeys(getAdapterClass(slug.success ? slug.data : ""), async () =>
      parseWith(newConnectionSchema, body),
    );
    const created = await found(`Unknown adapter. ${adapterNames()}`, () => createConnection(actor, input));
    io.err(`${created.message} ID: ${created.id}\n`);
    io.out(json(await showConnection(created.id)));
  } else {
    const body = await readJsonBody(io);
    const editable = await found(`No connection has the ID ${id}.`, () => editableConnection(id));
    const input = await knownSecretKeys(editable.cls, async () => parseWith(connectionInputSchema, body));
    const saved = await updateConnection(actor, editable, input);
    io.err(`${saved.message}\n`);
    io.out(json(await showConnection(id)));
  }
}

function onlyConnections(name: SettingName, verb: string): void {
  if (name !== "connections") throw new UsageError(`${name} has no ${verb}: only connections do.`);
}

async function remove(id: number, command: string, io: Io) {
  const connection = await found(`No connection has the ID ${id}.`, () => connectionOr404(id));
  const { message } = await deleteConnection(operator(command), connection);
  io.err(`${message}\n`);
}

/** The test button: the result on stdout; exit 1 when the connection fails. */
async function test(id: number, command: string, io: Io): Promise<number> {
  const connection = await found(`No connection has the ID ${id}.`, () => connectionOr404(id));
  const result = await testConnection(operator(command), connection);
  io.out(json(result));
  if (result.ok) return 0;
  io.err(`${result.message}\n`);
  return 1;
}

/**
 * The "Import groups" button, or "Compare accounts now" ("Import people now"
 * for an HR system): the result on stdout; exit 1 when the read fails. The
 * read holds the schedule's read lock: its run, which names no app user,
 * looks like a scheduled one, and the worker closes such runs as stopped
 * only while it holds that lock.
 */
async function read(verb: "import-groups" | "sync", id: number, command: string, io: Io): Promise<number> {
  const connection = await found(`No connection has the ID ${id}.`, () => connectionOr404(id));
  const actor = operator(command);
  const run = await exclusive(SYNC_LOCK_ID, () =>
    verb === "import-groups"
      ? importGroups(connection, actor)
      : kindOf(connection) === AdapterKind.HR_SOURCE
        ? importPeople(connection, actor)
        : compareAccounts(connection, actor),
  );
  if (run === null)
    throw new AppError(409, "busy", "Another connection read is running. Try again in a minute.");
  const answer = runAnswer(run);
  io.out(json(answer));
  if (answer.ok) return 0;
  io.err(`${answer.message}\n`);
  return 1;
}

export function runSettings(args: string[], io: Io): Promise<number> {
  return run(io, async () => {
    const [verb, ...rest] = args;
    switch (verb) {
      case "list": {
        const parsed = parseArgs(rest, { positionals: 0, flags: ["--json"] });
        return list(parsed.flags.has("--json"), io);
      }
      case "show": {
        const parsed = parseArgs(rest, { positionals: 1, options: ["--id", "--adapter"] });
        const name = settingName(parsed.positionals[0]);
        return show(name, idOption(parsed, false), parsed.options.get("--adapter"), io);
      }
      case "apply":
      case "remove":
      case "test":
      case "import-groups":
      case "sync": {
        const parsed = parseArgs(rest, { positionals: 1, options: ["--id"] });
        const name = settingName(parsed.positionals[0]);
        if (verb !== "apply") onlyConnections(name, verb === "remove" ? "entries to remove" : verb);
        const id = idOption(parsed, verb !== "apply");
        // The audit log names the command; an ID is no secret.
        const command = `cli settings ${verb} ${name}${id === undefined ? "" : ` --id ${id}`}`;
        if (verb === "apply") return apply(name, id, command, io);
        if (verb === "remove") return remove(id!, command, io);
        if (verb === "test") return test(id!, command, io);
        return read(verb, id!, command, io);
      }
      default:
        throw new UsageError(
          verb === undefined
            ? "Name a command: list, show, apply, remove, test, import-groups or sync."
            : "Unknown command (not shown). Commands: list, show, apply, remove, test, import-groups, sync.",
        );
    }
  });
}
