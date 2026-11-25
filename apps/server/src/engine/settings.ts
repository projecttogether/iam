import { eq } from "drizzle-orm";
import { appSettings, type AppSettings } from "../db/schema";
import { q } from "../db/tx";

/** General settings an admin changes in Admin › Settings: one row, created on first use. */
export async function loadSettings(): Promise<AppSettings> {
  const [row] = await q().select().from(appSettings).where(eq(appSettings.id, 1));
  if (row) return row;
  await q().insert(appSettings).values({ id: 1 }).onConflictDoNothing();
  const [created] = await q().select().from(appSettings).where(eq(appSettings.id, 1));
  return created!;
}

/** The addresses that get an email for new manual tasks. */
export function notificationRecipients(settings: Pick<AppSettings, "notificationEmails">): string[] {
  return settings.notificationEmails
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
