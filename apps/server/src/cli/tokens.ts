import { apiKeyInputSchema } from "@iam/shared/api/iam";
import { operator } from "../engine/audit";
import { AppError, parseWith } from "../http/errors";
import { createApiKey, keyRows, revokeApiKey } from "../modules/identity-requests";
import { json, parseArgs, run, UsageError, type Io } from "./command";

/**
 * `cli tokens`: the API keys other apps send identity requests with
 * (Admin › API keys, docs/api.md), through the same functions as the page,
 * as the operator. A new key is printed once, alone on stdout, so that
 * `> file` keeps only the key.
 */

export const TOKEN_KINDS = ["api-key"] as const;

function kind(value: string | undefined): void {
  if (value === undefined) throw new UsageError(`Name a kind: ${TOKEN_KINDS.join(", ")}.`);
  if (!(TOKEN_KINDS as readonly string[]).includes(value)) {
    throw new UsageError(`Unknown kind (not shown). Kinds: ${TOKEN_KINDS.join(", ")}.`);
  }
}

async function create(args: string[], io: Io) {
  const parsed = parseArgs(args, { positionals: 1, options: ["--name"] });
  kind(parsed.positionals[0]);
  const name = parsed.options.get("--name");
  if (name === undefined) throw new UsageError("Name the key with --name, e.g. --name Helpdesk.");
  const created = await createApiKey(
    operator("cli tokens create api-key"),
    parseWith(apiKeyInputSchema, { name }),
  );
  io.out(`${created.key}\n`);
  io.err(`${created.message} ID: ${created.apiKey.id}, prefix: ${created.apiKey.prefix}\n`);
}

async function list(args: string[], io: Io) {
  const parsed = parseArgs(args, { positionals: 0, flags: ["--json"] });
  const rows = await keyRows();
  if (parsed.flags.has("--json")) {
    io.out(json(rows));
    return;
  }
  if (rows.length === 0) {
    io.out("No API keys.\n");
    return;
  }
  const labels = rows.map((row) => `api-key ${row.id}`);
  const width = Math.max(...labels.map((label) => label.length));
  io.out(
    rows
      .map((row, index) => {
        const hints = [
          row.name,
          `${row.prefix}…`,
          `created ${row.createdAt.slice(0, 10)}${row.createdBy ? ` by ${row.createdBy}` : ""}`,
          `last used ${row.lastUsedAt?.slice(0, 10) ?? "never"}`,
        ];
        const state = row.revokedAt ? `revoked ${row.revokedAt.slice(0, 10)}` : "active";
        return `${labels[index]!.padEnd(width)}  ${state.padEnd(18)}  ${hints.join("; ")}\n`;
      })
      .join(""),
  );
}

async function revoke(args: string[], io: Io) {
  const value = parseArgs(args, { positionals: 1 }).positionals[0];
  if (value === undefined)
    throw new UsageError("Give the key's ID: cli tokens revoke <id> (cli tokens list shows them).");
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new UsageError("The ID is a positive whole number.");
  const id = Number(value);
  try {
    const { message } = await revokeApiKey(operator(`cli tokens revoke ${id}`), id);
    io.err(`${message}\n`);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") {
      throw new AppError(404, "not_found", `No API key has the ID ${id}.`);
    }
    throw error;
  }
}

export function runTokens(args: string[], io: Io): Promise<number> {
  return run(io, async () => {
    const [verb, ...rest] = args;
    switch (verb) {
      case "create":
        return create(rest, io);
      case "list":
        return list(rest, io);
      case "revoke":
        return revoke(rest, io);
      default:
        throw new UsageError(
          verb === undefined
            ? "Name a command: create, list or revoke."
            : "Unknown command (not shown). Commands: create, list, revoke.",
        );
    }
  });
}
