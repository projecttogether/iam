import type { ReadStream } from "node:tty";
import { eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { closeDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { connections, users } from "./db/schema";
import { atomic, q } from "./db/tx";
import { generateKey, rotate } from "./core/crypto";
import { operator, record } from "./engine/audit";
import { seedDemo } from "./engine/demo";
import { config } from "./config";
import { adapterNames, runSettings, SETTING_NAMES } from "./cli/settings";
import { runTokens, TOKEN_KINDS } from "./cli/tokens";
import { UsageError, type Io } from "./cli/command";

/**
 * Commands for operators (docs/deployment.md); `cli help` lists them. In
 * the image: `docker compose run --rm -T migrate cli <command>`, or `cli …`
 * in a running container (the image has it on its PATH).
 */

const HELP = `IAM operator commands. On a server: docker compose run --rm -T migrate cli <command>

  settings list [--json]                     every setting: name, set or not, hints (never a secret)
  settings show <name> [--id <id>]           what the admin page shows, as JSON
  settings show connections --adapter <slug> the fields of an adapter
  settings apply <name> [--id <id>]          save the JSON body on stdin, as the admin page does;
                                             connections without --id: add one, print its ID
  settings remove connections --id <id>      delete a connection
  settings test connections --id <id>        the test button
  tokens create api-key --name <name>        a new API key for another app, alone on stdout; run it with
                                             docker compose exec -T web cli …: Docker logs what "run" prints
  tokens list [--json]                       the API keys (never a key)
  tokens revoke <id>                         revoke an API key
  create-admin --email <address> [--name <name>]
                                             create or reactivate an admin app user
  generate-key                               print a new ENCRYPTION_KEY value
  rotate-secrets                             re-encrypt connection secrets with the first ENCRYPTION_KEY
  migrate                                    apply database migrations
  seed-demo [--admin-email <address>]        demo data (development only)
  help                                       this list

Settings: ${SETTING_NAMES.join(", ")}. Token kinds: ${TOKEN_KINDS.join(", ")}.
${adapterNames()}
Secrets go only on stdin, never as arguments. Exit codes: 0 done, 1 refused, 2 wrong command.
Docs: docs/deployment.md, "Settings from the command line".
`;

/** The longest body on stdin. */
const MAX_STDIN_BYTES = 1024 * 1024;

const tooLong = () => new UsageError("The body on stdin is longer than 1 MB.");

/**
 * A body pasted into a terminal (a web terminal's): read in raw mode, so the terminal shows
 * nothing and does not cut a line at its 4 KiB limit. Ctrl-D ends the body; Ctrl-C
 * stops the command. The rest of a body over the limit is read and dropped, still in
 * raw mode, until Ctrl-D. Node restores the terminal's mode when the process exits.
 */
function readPasted(): Promise<Buffer> {
  const stdin = process.stdin as ReadStream;
  stdin.setRawMode(true);
  process.stderr.write("Paste the JSON body (it is not shown), then press Ctrl-D.\n");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      const end = chunk.indexOf(0x04);
      const cancel = chunk.indexOf(0x03);
      if (cancel !== -1 && (end === -1 || cancel < end)) {
        finish();
        process.exit(130);
      }
      const part = end === -1 ? chunk : chunk.subarray(0, end);
      size += part.length;
      if (size > MAX_STDIN_BYTES) chunks.length = 0;
      else chunks.push(part);
      if (end !== -1) finish(size > MAX_STDIN_BYTES ? tooLong() : undefined);
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function readPiped(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw tooLong();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const processIo: Io = {
  // A body pasted in a terminal is not shown; a heredoc would put it into the shell's history.
  readStdin: async () => (process.stdin.isTTY ? await readPasted() : await readPiped()).toString("utf8"),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function createAdmin(args: string[]) {
  const email = (option(args, "--email") ?? "").trim().toLowerCase();
  const name = option(args, "--name") ?? "";
  if (!z.email().safeParse(email).success) throw new Error("Enter a valid email address.");
  await atomic(async () => {
    const [user] = await q()
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    let verb: string;
    let id: number;
    if (!user) {
      const [created] = await q()
        .insert(users)
        .values({ email, role: "admin", displayName: name })
        .returning();
      verb = "Created";
      id = created!.id;
    } else {
      await q()
        .update(users)
        .set({ role: "admin", roleSource: "local", isActive: true })
        .where(eq(users.id, user.id));
      verb = "Updated";
      id = user.id;
    }
    await record("user.saved", `${verb} admin ${email} from the command line`, {
      actor: operator("cli create-admin"),
      target: { type: "user", id },
    });
    process.stdout.write(`${verb} admin ${email}. Sign in with this address.\n`);
  });
}

async function rotateSecrets() {
  let count = 0;
  await atomic(async () => {
    const rows = await q().select().from(connections).where(ne(connections.secretData, "")).for("update");
    for (const connection of rows) {
      await q()
        .update(connections)
        .set({ secretData: rotate(connection.secretData) })
        .where(eq(connections.id, connection.id));
      count += 1;
    }
  });
  process.stdout.write(`Re-encrypted the secrets of ${count} connection(s).\n`);
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  switch (command) {
    case "generate-key":
      process.stdout.write(`${generateKey()}\n`);
      return;
    case "create-admin":
      return createAdmin(rest);
    case "rotate-secrets":
      return rotateSecrets();
    case "migrate":
      return runMigrations();
    case "seed-demo":
      if (!config().isDevelopment) throw new Error("seed-demo runs only with NODE_ENV=development.");
      await seedDemo(option(rest, "--admin-email") ?? "admin@example.invalid");
      process.stdout.write("Demo data ready.\n");
      return;
    case "settings":
      process.exitCode = await runSettings(rest, processIo);
      return;
    case "tokens":
      process.exitCode = await runTokens(rest, processIo);
      return;
    case "help":
    case "--help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(HELP);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
