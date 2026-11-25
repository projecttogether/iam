import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { settingsInputSchema, type Settings } from "@iam/shared/api/iam";
import { appSettings } from "../db/schema";
import { atomic, q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { jsonBody, requireRole } from "../http/middleware";
import { record, type Actor } from "../engine/audit";
import { loadSettings } from "../engine/settings";

/** Admin › Settings: lifecycle rules, notifications and which identity requests other apps may send. */
const router = new Hono<AppEnv>();

const FIELD_NAMES: Record<keyof Settings, string> = {
  organizationName: "organization_name",
  automaticOnboarding: "automatic_onboarding",
  onboardingLeadDays: "onboarding_lead_days",
  automaticOffboarding: "automatic_offboarding",
  removalLimitPerDay: "removal_limit_per_day",
  notificationEmails: "notification_emails",
  identityRequestTypes: "identity_request_types",
};

function view(settings: Settings): Settings {
  return {
    organizationName: settings.organizationName,
    automaticOnboarding: settings.automaticOnboarding,
    onboardingLeadDays: settings.onboardingLeadDays,
    automaticOffboarding: settings.automaticOffboarding,
    removalLimitPerDay: settings.removalLimitPerDay,
    notificationEmails: settings.notificationEmails,
    identityRequestTypes: settings.identityRequestTypes,
  };
}

/** What Admin › Settings shows (GET /settings, `cli settings show app`). */
export async function settingsView(): Promise<Settings> {
  return view(await loadSettings());
}

/** Saves Admin › Settings (PUT /settings, `cli settings apply app`). */
export async function saveSettings(
  actor: Actor,
  input: z.infer<typeof settingsInputSchema>,
): Promise<Settings & { message: string }> {
  await atomic(async () => {
    const current = view(await loadSettings());
    const changed = (Object.keys(FIELD_NAMES) as (keyof Settings)[]).filter(
      (key) => JSON.stringify(current[key]) !== JSON.stringify(input[key]),
    );
    await q().update(appSettings).set(input).where(eq(appSettings.id, 1));
    await record("settings.saved", "Changed settings", {
      actor,
      details: { fields: changed.map((key) => FIELD_NAMES[key]).sort() },
    });
  });
  return { ...(await settingsView()), message: "Saved the settings." };
}

router.get("/settings", async (c) => {
  requireRole(c, "admin");
  return c.json(await settingsView());
});

router.put("/settings", async (c) => {
  const user = requireRole(c, "admin");
  const input = await jsonBody(c, settingsInputSchema);
  return c.json(await saveSettings(user, input));
});

export default router;
