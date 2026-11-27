import { Hono } from "hono";
import type { z } from "zod";
import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import {
  connectionInputSchema,
  manualGroupSchema,
  type AdapterInfo,
  type ConnectionDetail,
  type ConnectionForm,
  type ConnectionRow,
} from "@iam/shared/api/iam";
import {
  ADAPTER_KIND_LABELS,
  SYNC_KIND_LABELS,
  type AdapterKind as AdapterKindName,
} from "@iam/shared/labels";
import { AdapterError, AdapterKind, type AdapterClass, type Field } from "../adapters/base";
import { adapterClasses, getAdapterClass } from "../adapters/registry";
import { SecretUnreadable } from "../core/crypto";
import {
  accessProfiles,
  accounts,
  connections,
  jobs,
  people,
  profileGrants,
  providerGroups,
  syncRuns,
  teamGroups,
  profileGrantGroups,
  users,
  type Connection,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, requireRole } from "../http/middleware";
import { AppError, notFound, validationError } from "../http/errors";
import { logger } from "../logger";
import { record, type Actor } from "../engine/audit";
import {
  adapterClassOf,
  buildAdapter,
  canImportGroups,
  encryptSecrets,
  kindOf,
  secretsOf,
  supportsGroups,
  syncIntervalMinutes,
} from "../engine/connections";
import { fullName } from "../engine/people";
import { groupLabel } from "../engine/policy";
import { canCompareAccounts, compareAccounts, importGroups, importPeople } from "../engine/sync";
import { iso } from "./rows";
import { isEmail } from "@iam/shared/email";

/** Admin › Connections: add, test, configure and read connected apps. */
const router = new Hono<AppEnv>();

export function adapterInfo(cls: AdapterClass): AdapterInfo {
  return {
    slug: cls.slug,
    name: cls.label,
    kind: cls.kind,
    description: cls.description,
    fields: cls.fields.map((spec) => ({
      name: spec.name,
      label: spec.label,
      kind: spec.kind,
      required: spec.required,
      help: spec.help,
      default: spec.default,
      choices: spec.choices,
      placeholder: spec.placeholder,
    })),
    hasMode: cls.supportsWrite && cls.kind === AdapterKind.PROVISIONING,
    supportsWrite: cls.supportsWrite,
    supportsGroups: cls.supportsGroups,
    groupLabel: cls.groupLabel,
    manualGroups: cls.manualGroups,
  };
}

function connectionRow(connection: Connection): ConnectionRow {
  return {
    id: connection.id,
    name: connection.name,
    adapterName: adapterClassOf(connection)?.label ?? connection.adapter,
    enabled: connection.enabled,
    status: connection.status,
    mode: connection.mode,
    kind: kindOf(connection),
    checkedAt: iso(connection.checkedAt),
  };
}

/** The saved secrets. Secrets no configured key can read count as not saved, so the admin enters them again. */
export function savedSecrets(connection: Connection | null): Record<string, string> {
  if (connection === null || !connection.secretData) return {};
  try {
    return secretsOf(connection);
  } catch (error) {
    if (error instanceof SecretUnreadable) return {};
    throw error;
  }
}

/** Every connection's name, for the filter of the jobs list (viewers read it). */
router.get("/connection-names", async (c) => {
  requireRole(c, "viewer");
  const rows = await q()
    .select({ id: connections.id, name: connections.name })
    .from(connections)
    .orderBy(asc(connections.name));
  return c.json(rows);
});

/** Every connection by kind (GET /connections, `cli settings show connections`). */
export async function connectionList() {
  const rows = await q().select().from(connections).orderBy(asc(connections.name));
  const sections = (Object.keys(ADAPTER_KIND_LABELS) as AdapterKindName[]).map((kind) => ({
    kind,
    label: ADAPTER_KIND_LABELS[kind],
    connections: rows.filter((row) => (kindOf(row) || AdapterKind.PROVISIONING) === kind).map(connectionRow),
  }));
  return { sections, hasConnections: rows.length > 0 };
}

router.get("/connections", async (c) => {
  requireRole(c, "admin");
  return c.json(await connectionList());
});

router.get("/adapters", (c) => {
  requireRole(c, "admin");
  const sections = (Object.keys(ADAPTER_KIND_LABELS) as AdapterKindName[]).map((kind) => ({
    kind,
    label: ADAPTER_KIND_LABELS[kind],
    adapters: adapterClasses()
      .filter((cls) => cls.kind === kind)
      .map(adapterInfo),
  }));
  return c.json(sections);
});

router.get("/adapters/:slug", (c) => {
  requireRole(c, "admin");
  const cls = getAdapterClass(c.req.param("slug"));
  if (!cls) throw notFound();
  return c.json(adapterInfo(cls));
});

export async function connectionOr404(id: number): Promise<Connection> {
  const [connection] = await q().select().from(connections).where(eq(connections.id, id));
  if (!connection) throw notFound();
  return connection;
}

/** One line from a sync run summary: lists count, numbers show. */
function summarize(summary: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(summary ?? {})) {
    const label = key.replaceAll("_", " ");
    if (Array.isArray(value)) {
      if (value.length > 0) parts.push(`${label}: ${value.length}`);
    } else if (value !== null && typeof value === "object") {
      if (Object.keys(value).length > 0) parts.push(`${label}: ${Object.keys(value).length}`);
    } else {
      parts.push(`${label}: ${pythonish(value)}`);
    }
  }
  return parts.join(" · ");
}

const pythonish = (value: unknown) =>
  value === true ? "True" : value === false ? "False" : value === null ? "None" : String(value);

router.get("/connections/:id", async (c) => {
  requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  const cls = adapterClassOf(connection);
  const saved = savedSecrets(connection);
  const groups = await q()
    .select()
    .from(providerGroups)
    .where(eq(providerGroups.connectionId, connection.id))
    .orderBy(asc(providerGroups.path), asc(providerGroups.name), asc(providerGroups.id));
  const accountRows = await q()
    .select({ account: accounts, person: people })
    .from(accounts)
    .leftJoin(people, eq(people.id, accounts.personId))
    .where(eq(accounts.connectionId, connection.id))
    .orderBy(asc(accounts.username), asc(accounts.id))
    .limit(500);
  const [accountCount] = await q()
    .select({ value: count() })
    .from(accounts)
    .where(eq(accounts.connectionId, connection.id));
  const runs = await q()
    .select({ run: syncRuns, user: users })
    .from(syncRuns)
    .leftJoin(users, eq(users.id, syncRuns.triggeredById))
    .where(eq(syncRuns.connectionId, connection.id))
    .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
    .limit(10);
  const grants = await q()
    .select({ id: accessProfiles.id, name: accessProfiles.name })
    .from(profileGrants)
    .innerJoin(accessProfiles, eq(accessProfiles.id, profileGrants.profileId))
    .where(eq(profileGrants.connectionId, connection.id))
    .orderBy(asc(accessProfiles.name));
  const [job] = await q()
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.connectionId, connection.id))
    .limit(1);
  const body: ConnectionDetail = {
    ...connectionRow(connection),
    adapter: cls ? adapterInfo(cls) : null,
    statusMessage: connection.statusMessage,
    checkedAt: iso(connection.checkedAt),
    settings: (cls?.fields ?? [])
      .filter((spec) => spec.kind !== "secret")
      .map((spec) => ({ label: spec.label, kind: spec.kind, value: connection.settings[spec.name] ?? null })),
    secrets: (cls?.fields ?? [])
      .filter((spec) => spec.kind === "secret")
      .map((spec) => ({ label: spec.label, saved: spec.name in saved })),
    supportsGroups: supportsGroups(connection),
    canImportGroups: canImportGroups(connection),
    canCompare: cls !== null && canCompareAccounts(connection),
    syncIntervalMinutes: syncIntervalMinutes(connection),
    groupsSyncedAt: iso(connection.groupsSyncedAt),
    groups: groups.map((group) => ({
      id: group.id,
      label: groupLabel(group),
      externalId: group.externalId,
      missing: group.missing,
      manual: group.manual,
    })),
    accounts: accountRows.map(({ account, person }) => ({
      id: account.id,
      label: account.username || account.email || account.externalId,
      person: person ? { id: person.id, name: fullName(person) } : null,
      status: account.status,
      observedAt: iso(account.observedAt),
    })),
    accountCount: Number(accountCount?.value ?? 0),
    syncRuns: runs.map(({ run, user }) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      triggeredBy: user ? user.displayName || user.email : null,
      error: run.error,
      summary: summarize(run.summary),
    })),
    grants,
    deletable: !job && grants.length === 0,
  };
  return c.json(body);
});

/** A connection that its adapter still knows, to edit (404 otherwise). */
export async function editableConnection(id: number): Promise<{ connection: Connection; cls: AdapterClass }> {
  const connection = await connectionOr404(id);
  const cls = adapterClassOf(connection);
  if (!cls) throw notFound();
  return { connection, cls };
}

/** What the edit form shows (GET /connections/:id/form, `cli settings show connections --id`): no secret values. */
export function connectionForm(connection: Connection, cls: AdapterClass): ConnectionForm {
  const settings: Record<string, unknown> = {};
  for (const spec of cls.fields) {
    if (spec.kind === "secret") continue;
    // As Django's form: the saved values; a setting the connection never saved stays empty.
    settings[spec.name] =
      spec.name in connection.settings ? connection.settings[spec.name] : spec.kind === "bool" ? false : "";
  }
  return {
    adapter: adapterInfo(cls),
    name: connection.name,
    enabled: connection.enabled,
    mode: connection.mode,
    settings,
    savedSecrets: Object.keys(savedSecrets(connection)),
  };
}

router.get("/connections/:id/form", async (c) => {
  requireRole(c, "admin");
  const { connection, cls } = await editableConnection(idParam(c));
  return c.json(connectionForm(connection, cls));
});

const URL_PATTERN = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;

/** A setting's value as the form field reads it, or an error message. */
function cleanSetting(spec: Field, raw: unknown): { value: unknown } | { error: string } {
  if (spec.kind === "bool") return { value: raw === true || raw === "true" || raw === "on" };
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text === "") {
    if (spec.required) return { error: "This field is required." };
    return { value: spec.kind === "int" ? null : "" };
  }
  switch (spec.kind) {
    case "int": {
      // Django's IntegerField takes "10.0" as 10.
      const whole = text.replace(/\.0*\s*$/, "");
      if (!/^[+-]?\d+$/.test(whole)) return { error: "Enter a whole number." };
      const value = Number(whole);
      if (value < 0) return { error: "Ensure this value is greater than or equal to 0." };
      return { value };
    }
    case "choice":
      return spec.choices.some(([choice]) => choice === text)
        ? { value: text }
        : { error: `Select a valid choice. ${text} is not one of the available choices.` };
    case "email":
      return isEmail(text) ? { value: text } : { error: "Enter a valid email address." };
    case "url":
      return URL_PATTERN.test(text) && isUrl(text) ? { value: text } : { error: "Enter a valid URL." };
    case "textarea":
      return { value: String(raw) };
    default:
      return { value: text };
  }
}

function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** The value the adapter works with: an empty setting means its default. */
function effective(spec: Field, value: unknown): unknown {
  return (value === null || value === undefined || value === "" ? spec.default : value) || "";
}

async function saveConnection(
  cls: AdapterClass,
  existing: Connection | null,
  input: ReturnType<typeof connectionInputSchema.parse>,
): Promise<{ connection: Connection; changed: string[] }> {
  const errors: Record<string, string> = {};
  const taken = await q()
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        sql`lower(${connections.name}) = lower(${input.name})`,
        existing ? ne(connections.id, existing.id) : undefined,
      ),
    )
    .limit(1);
  if (taken.length > 0) errors.name = "Another connection has this name.";
  const values: Record<string, unknown> = {};
  for (const spec of cls.fields) {
    if (spec.kind === "secret") continue;
    const cleaned = cleanSetting(spec, input.settings[spec.name]);
    if ("error" in cleaned) errors[`settings.${spec.name}`] = cleaned.error;
    else values[spec.name] = cleaned.value ?? "";
  }
  const saved = savedSecrets(existing);
  const secrets: Record<string, string> = { ...saved };
  for (const spec of cls.fields) {
    if (spec.kind !== "secret") continue;
    const value = input.secrets[spec.name] ?? "";
    if (value) secrets[spec.name] = value;
    else if (spec.required && !(spec.name in saved))
      errors[`secrets.${spec.name}`] = "This field is required.";
  }
  // Security: a saved secret must not follow a changed URL or host, or an
  // admin session could send it to any server.
  if (existing !== null && Object.keys(saved).length > 0) {
    const moved = cls.fields
      .filter(
        (spec) =>
          spec.destination &&
          spec.kind !== "secret" &&
          !(`settings.${spec.name}` in errors) &&
          effective(spec, values[spec.name]) !== effective(spec, existing.settings[spec.name]),
      )
      .map((spec) => spec.label);
    if (moved.length > 0) {
      for (const spec of cls.fields) {
        if (spec.kind === "secret" && spec.name in saved && !input.secrets[spec.name]) {
          errors[`secrets.${spec.name}`] = `Enter it again: ${moved.join(", ")} changed where it is sent.`;
        }
      }
    }
  }
  if (Object.keys(errors).length > 0) throw validationError(errors);
  const hasMode = cls.supportsWrite && cls.kind === AdapterKind.PROVISIONING;
  const mode = hasMode ? (input.mode ?? "automatic") : cls.supportsWrite ? "automatic" : "manual";
  const changed: string[] = [];
  for (const spec of cls.fields) {
    if (spec.kind === "secret") {
      if (input.secrets[spec.name]) changed.push(spec.name);
    } else if (
      existing === null
        ? !sameValue(values[spec.name], spec.default ?? "")
        : !sameValue(values[spec.name], existing.settings[spec.name] ?? "")
    ) {
      changed.push(spec.name);
    }
  }
  if (existing === null ? input.name !== cls.label : input.name !== existing.name) changed.push("name");
  if (existing === null ? input.enabled : input.enabled !== existing.enabled) changed.push("enabled");
  if (hasMode && (existing === null ? mode !== "automatic" : mode !== existing.mode)) changed.push("mode");
  const row = {
    adapter: cls.slug,
    name: input.name,
    enabled: input.enabled,
    mode,
    settings: values,
    secretData: encryptSecrets(secrets),
    status: "untested" as const,
    statusMessage: "",
  };
  const [connection] = existing
    ? await q().update(connections).set(row).where(eq(connections.id, existing.id)).returning()
    : await q().insert(connections).values(row).returning();
  return { connection: connection!, changed };
}

function sameValue(a: unknown, b: unknown): boolean {
  return String(a ?? "") === String(b ?? "");
}

/** The body that adds a connection: an edit's body and the adapter's slug. */
export const newConnectionSchema = connectionInputSchema.extend({
  adapter: connectionInputSchema.shape.name,
});

/** Adds a connection (POST /connections, `cli settings apply connections`). */
export async function createConnection(
  actor: Actor,
  body: z.infer<typeof newConnectionSchema>,
): Promise<{ id: number; message: string }> {
  const cls = getAdapterClass(body.adapter);
  if (!cls) throw notFound();
  const { connection } = await atomic(async () => {
    const result = await saveConnection(cls, null, body);
    await record("connection.created", `Added connection ${result.connection.name} (${cls.label})`, {
      actor,
      target: { type: "connection", id: result.connection.id },
      details: { settings_changed: changedNames(result.changed) },
    });
    return result;
  });
  return { id: connection.id, message: `Added ${connection.name}. Test it before turning it on.` };
}

router.post("/connections", async (c) => {
  const user = requireRole(c, "admin");
  const body = await jsonBody(c, newConnectionSchema);
  return c.json(await createConnection(user, body), 201);
});

/** Names of changed settings for the audit log, never values: settings first, then name, enabled, mode. */
function changedNames(names: string[]): string[] {
  const general = ["name", "enabled", "mode"];
  return [
    ...names.filter((name) => !general.includes(name)),
    ...general.filter((name) => names.includes(name)),
  ];
}

/** Saves a connection of `editableConnection` (PUT /connections/:id, `cli settings apply connections --id`). */
export async function updateConnection(
  actor: Actor,
  { connection: existing, cls }: { connection: Connection; cls: AdapterClass },
  input: z.infer<typeof connectionInputSchema>,
): Promise<{ id: number; message: string }> {
  const connection = await atomic(async () => {
    const result = await saveConnection(cls, existing, input);
    await record("connection.updated", `Changed connection ${result.connection.name}`, {
      actor,
      target: { type: "connection", id: existing.id },
      details: { settings_changed: changedNames(result.changed) },
    });
    return result.connection;
  });
  return { id: connection.id, message: `Saved ${connection.name}.` };
}

router.put("/connections/:id", async (c) => {
  const user = requireRole(c, "admin");
  const editable = await editableConnection(idParam(c));
  const input = await jsonBody(c, connectionInputSchema);
  return c.json(await updateConnection(user, editable, input));
});

/** The test button (POST /connections/:id/test, `cli settings test connections`): saves and returns the result. */
export async function testConnection(
  actor: Actor,
  connection: Connection,
): Promise<{ ok: boolean; message: string }> {
  let ok: boolean;
  let message: string;
  try {
    const result = await buildAdapter(connection).testConnection();
    ok = result.ok;
    message = result.message;
  } catch (error) {
    ok = false;
    if (error instanceof AdapterError || error instanceof SecretUnreadable) message = error.message;
    else {
      // Shown to the admin; the details are in the log.
      logger.error({ err: error, connectionId: connection.id }, "connection test failed");
      message = `Unexpected error (${error instanceof Error ? error.constructor.name : typeof error}).`;
    }
  }
  await q()
    .update(connections)
    .set({ status: ok ? "ok" : "error", statusMessage: message.slice(0, 2000), checkedAt: new Date() })
    .where(eq(connections.id, connection.id));
  await record("connection.tested", `Tested ${connection.name}: ${ok ? "connected" : "error"}`, {
    actor,
    target: { type: "connection", id: connection.id },
  });
  return { ok, message };
}

router.post("/connections/:id/test", async (c) => {
  const user = requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  return c.json(await testConnection(user, connection));
});

router.post("/connections/:id/toggle", async (c) => {
  const user = requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  const enabled = !connection.enabled;
  await q().update(connections).set({ enabled }).where(eq(connections.id, connection.id));
  const state = enabled ? "on" : "off";
  await record("connection.toggled", `Turned ${connection.name} ${state}`, {
    actor: user,
    target: { type: "connection", id: connection.id },
  });
  return c.json({ message: `Turned ${connection.name} ${state}.` });
});

export function runAnswer(run: { kind: keyof typeof SYNC_KIND_LABELS; status: string; error: string }) {
  const label = SYNC_KIND_LABELS[run.kind];
  return run.status === "succeeded"
    ? { ok: true, message: `${label} finished.` }
    : { ok: false, message: `${label} failed: ${run.error}` };
}

router.post("/connections/:id/import-groups", async (c) => {
  const user = requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  return c.json(runAnswer(await importGroups(connection, user)));
});

router.post("/connections/:id/sync", async (c) => {
  const user = requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  const run =
    kindOf(connection) === AdapterKind.HR_SOURCE
      ? await importPeople(connection, user)
      : await compareAccounts(connection, user);
  return c.json(runAnswer(run));
});

router.post("/connections/:id/groups", async (c) => {
  const user = requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  const cls = adapterClassOf(connection);
  const parsed = manualGroupSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!cls || !cls.manualGroups || !parsed.success) throw validationError({ name: "Enter a name." });
  const name = parsed.data.name.slice(0, 255);
  // Lowercasing can lengthen a name; the ID must fit in 255 characters.
  const externalId = `manual:${name.toLowerCase().slice(0, 248)}`;
  const [created] = await q()
    .insert(providerGroups)
    .values({ connectionId: connection.id, externalId, name, manual: true })
    .onConflictDoNothing()
    .returning();
  if (created) {
    await record("group.added", `Added ${name} to ${connection.name}`, {
      actor: user,
      target: { type: "providergroup", id: created.id },
    });
  }
  return c.json({ message: created ? `Added ${name}.` : `${name} is already there.` });
});

router.delete("/connections/:id/groups/:groupId", async (c) => {
  const user = requireRole(c, "admin");
  const connectionId = idParam(c);
  const groupId = idParam(c, "groupId");
  const [group] = await q()
    .select()
    .from(providerGroups)
    .where(
      and(
        eq(providerGroups.id, groupId),
        eq(providerGroups.connectionId, connectionId),
        eq(providerGroups.manual, true),
      ),
    );
  if (!group) throw notFound();
  const [inGrant] = await q()
    .select({ id: profileGrantGroups.id })
    .from(profileGrantGroups)
    .where(eq(profileGrantGroups.providerGroupId, group.id))
    .limit(1);
  const [inTeam] = await q()
    .select({ id: teamGroups.id })
    .from(teamGroups)
    .where(eq(teamGroups.providerGroupId, group.id))
    .limit(1);
  if (inGrant || inTeam)
    throw new AppError(409, "in_use", `${group.name} is still used by an access profile or team.`);
  await q().delete(providerGroups).where(eq(providerGroups.id, group.id));
  await record("group.removed", `Removed ${group.name}`, { actor: user });
  return c.json({ message: `Removed ${group.name}.` });
});

/** Deletes a connection without jobs or grants (DELETE /connections/:id, `cli settings remove connections`). */
export async function deleteConnection(actor: Actor, connection: Connection): Promise<{ message: string }> {
  await atomic(async () => {
    // Locked through the delete: a workflow that plans a job here meanwhile
    // either comes first (and the check sees its job) or waits and fails.
    const [current] = await q()
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.id, connection.id))
      .for("update");
    if (!current) throw notFound();
    const [job] = await q()
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.connectionId, connection.id))
      .limit(1);
    const [grant] = await q()
      .select({ id: profileGrants.id })
      .from(profileGrants)
      .where(eq(profileGrants.connectionId, connection.id))
      .limit(1);
    if (job || grant) {
      throw new AppError(
        409,
        "in_use",
        "This connection has jobs or is used by access profiles. Turn it off instead.",
      );
    }
    await q().delete(connections).where(eq(connections.id, connection.id));
    await record("connection.deleted", `Deleted connection ${connection.name}`, { actor });
  });
  return { message: `Deleted ${connection.name}.` };
}

router.delete("/connections/:id", async (c) => {
  const user = requireRole(c, "admin");
  const connection = await connectionOr404(idParam(c));
  return c.json(await deleteConnection(user, connection));
});

export default router;
