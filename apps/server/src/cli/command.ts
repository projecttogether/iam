import { CONCURRENT_CHANGE_MESSAGE, isConcurrentChange } from "../db/errors";
import { AppError } from "../http/errors";
import { logger } from "../logger";

/**
 * What the operator commands share (docs/deployment.md, "Settings from the
 * command line"): their input and output, arguments, and exit codes: 0 done,
 * 1 the app refuses (the admin page's message on stderr), 2 a wrong command
 * or a body that is not JSON.
 *
 * Secrets come only on stdin: arguments show in `ps` and the shell history.
 * No message repeats an argument, which could be a secret typed in the wrong
 * place, or a body that is not JSON. Refusals are the admin page's messages.
 */

export type Io = {
  /** All of stdin as text. */
  readStdin: () => Promise<string>;
  /** The answer: JSON, a list, or a new token alone. */
  out: (text: string) => void;
  /** Notes and errors. */
  err: (text: string) => void;
};

/** A wrong command (exit 2). */
export class UsageError extends Error {}

export type Parsed = { positionals: string[]; options: Map<string, string>; flags: Set<string> };

/** Positional arguments, `--option value` pairs and `--flag`s; anything else is a UsageError. */
export function parseArgs(
  args: string[],
  allowed: { positionals: number; options?: string[]; flags?: string[] },
): Parsed {
  const parsed: Parsed = { positionals: [], options: new Map(), flags: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const known = [...(allowed.options ?? []), ...(allowed.flags ?? [])];
      if (allowed.flags?.includes(arg)) parsed.flags.add(arg);
      else if (allowed.options?.includes(arg)) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
        parsed.options.set(arg, value);
        index += 1;
      } else {
        throw new UsageError(
          `Unknown option (not shown). ${known.length > 0 ? `Options here: ${known.join(", ")}.` : "No options here."} Write an option and its value as two arguments.`,
        );
      }
    } else if (parsed.positionals.length < allowed.positionals) {
      parsed.positionals.push(arg);
    } else {
      throw new UsageError("Too many arguments (not shown). Bodies and secrets go on stdin.");
    }
  }
  return parsed;
}

/** `--id`: a positive whole number. */
export function idOption(parsed: Parsed, required: boolean): number | undefined {
  const value = parsed.options.get("--id");
  if (value === undefined) {
    if (required) throw new UsageError("Give the entry's ID with --id (cli settings list shows them).");
    return undefined;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new UsageError("--id takes a positive whole number.");
  return Number(value);
}

/** The JSON body on stdin. */
export async function readJsonBody(io: Io): Promise<unknown> {
  const text = await io.readStdin();
  if (text.trim() === "") throw new UsageError("Pipe the JSON body into the command: stdin is empty.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's message quotes the body, which may hold a secret.
    throw new UsageError("The body on stdin must be JSON.");
  }
}

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A refusal as the admin page shows it: the message, then each field's message. */
function refusal(error: AppError): string {
  const lines = [error.message];
  for (const [field, message] of Object.entries(error.fields ?? {})) {
    lines.push(`  ${field === "_" ? "body" : field}: ${message}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Runs a command and returns its exit code. Other errors end it as the
 * page's would: a concurrent change asks to try again; anything else is
 * logged (on stderr, without the values of a failed query, logger.ts) and
 * not printed, since a failed query's message quotes them.
 */
export async function run(io: Io, command: () => Promise<number | undefined | void>): Promise<number> {
  try {
    return (await command()) ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\nSee: cli help\n`);
      return 2;
    }
    if (error instanceof AppError) {
      io.err(refusal(error));
      return 1;
    }
    if (isConcurrentChange(error)) {
      io.err(`${CONCURRENT_CHANGE_MESSAGE}\n`);
      return 1;
    }
    logger.error({ err: error }, "operator command failed");
    io.err("Something went wrong. Try again.\n");
    return 1;
  }
}
