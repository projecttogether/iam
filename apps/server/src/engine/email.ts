import { asc, eq } from "drizzle-orm";
import { config } from "../config";
import { AdapterKind } from "../adapters/base";
import { connections, type Connection, type Task } from "../db/schema";
import { q } from "../db/tx";
import { logger } from "../logger";
import { buildAdapter, kindOf } from "./connections";
import { loadSettings, notificationRecipients } from "./settings";

/** Email: notifications about new tasks and initial passwords, through the first enabled email connection. */

export async function emailConnection(): Promise<Connection | null> {
  const rows = await q()
    .select()
    .from(connections)
    .where(eq(connections.enabled, true))
    .orderBy(asc(connections.id));
  return rows.find((connection) => kindOf(connection) === AdapterKind.EMAIL) ?? null;
}

/** Sends an email; best effort. Read-only mode sends none. */
export async function sendEmail(to: string[], subject: string, body: string): Promise<boolean> {
  if (config().READ_ONLY) {
    logger.info({ recipients: to.length }, "read-only mode: no email sent");
    return false;
  }
  const connection = await emailConnection();
  if (connection === null || to.length === 0) return false;
  try {
    await buildAdapter(connection).sendMessage({ to, subject, body });
  } catch (error) {
    logger.warn(
      { recipients: to.length, error: error instanceof Error ? error.name : "Error" },
      "email failed",
    );
    return false;
  }
  return true;
}

/**
 * Enough of an address to notice a wrong recipient in the audit log,
 * without keeping the private address there.
 */
export function maskEmail(address: string): string {
  const at = address.indexOf("@");
  const local = at === -1 ? address : address.slice(0, at);
  const domain = at === -1 ? "" : address.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Tells the notification addresses about new tasks. */
export async function notifyTasks(tasks: Pick<Task, "title">[]): Promise<void> {
  const recipients = notificationRecipients(await loadSettings());
  if (recipients.length === 0) return;
  const lines = ["New tasks in IAM:", ""];
  for (const task of tasks) lines.push(`- ${task.title}`);
  await sendEmail(recipients, `${tasks.length} new task(s) in IAM`, lines.join("\n"));
}
