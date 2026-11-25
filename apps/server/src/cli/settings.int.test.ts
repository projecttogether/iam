import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../adapters/base";
import { getDb } from "../db/client";
import { apiKeys, appSettings, auditEvents, connections, type AuditEvent } from "../db/schema";
import { secretsOf } from "../engine/connections";
import { apiKeyFrom, hashApiKey } from "../engine/identity-requests";
import { logger } from "../logger";
import { STORE } from "../test/fake-adapter";
import { makeConnection, makeProfile, makeUser, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";
import type { Io } from "./command";
import { runSettings } from "./settings";
import { runTokens } from "./tokens";

/**
 * `cli settings` and `cli tokens` against the database: they do what the
 * admin pages do (the same answers, checks and audit events), as the
 * operator, and no secret reaches stdout, stderr or the log.
 */

const SECRET = "cli-secret-value-7f3a";

async function cli(command: typeof runSettings, args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    readStdin: async () => stdin,
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const code = await command(args, io);
  return { code, out: out.join(""), err: err.join("") };
}

const settings = (args: string[], stdin?: unknown) =>
  cli(
    runSettings,
    args,
    typeof stdin === "string" ? stdin : stdin === undefined ? "" : JSON.stringify(stdin),
  );
const tokens = (args: string[]) => cli(runTokens, args);

const KEYCLOAK = {
  adapter: "keycloak",
  name: "Keycloak",
  enabled: false,
  mode: "automatic",
  settings: {
    base_url: "https://sso.example.invalid",
    realm: "example",
    client_id: "iam-admin",
    username_source: "username",
    setup_email_lifespan_hours: "72",
    sync_interval_minutes: "360",
  },
  secrets: { client_secret: SECRET },
};

async function events(action: string): Promise<AuditEvent[]> {
  return getDb().select().from(auditEvents).where(eq(auditEvents.action, action));
}

async function connectionById(id: number) {
  const [connection] = await getDb().select().from(connections).where(eq(connections.id, id));
  return connection;
}

describe("cli settings and cli tokens", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  const logged: unknown[][] = [];
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
  });
  afterAll(() => {
    stopTestHeader();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    // Whatever a test logged, no secret is in it.
    const text = JSON.stringify(logged, (_key, value: unknown) =>
      value instanceof Error ? `${value.message} ${value.stack}` : value,
    );
    expect(text).not.toContain(SECRET);
    logged.length = 0;
  });

  it("adds a connection as the page does, with the secret encrypted and never shown", async () => {
    const added = await settings(["apply", "connections"], KEYCLOAK);
    expect(added.code, added.err).toBe(0);
    expect(added.out + added.err).not.toContain(SECRET);
    const shown = JSON.parse(added.out);
    expect(added.err).toBe(`Added Keycloak. Test it before turning it on. ID: ${shown.id}\n`);
    expect(shown).toMatchObject({ name: "Keycloak", enabled: false, savedSecrets: ["client_secret"] });

    const connection = (await connectionById(shown.id))!;
    expect(connection.secretData).not.toContain(SECRET);
    expect(secretsOf(connection)).toEqual({ client_secret: SECRET });

    // `show --id` is the page's form read with the ID; the adapter's fields are its API read.
    const admin = await makeUser("admin");
    const form = await request("GET", `/api/v1/connections/${shown.id}/form`, { user: admin });
    expect(shown).toEqual({ id: shown.id, ...form.body });
    const again = await settings(["show", "connections", "--id", String(shown.id)]);
    expect(JSON.parse(again.out)).toEqual(shown);
    const adapter = await settings(["show", "connections", "--adapter", "keycloak"]);
    const api = await request("GET", "/api/v1/adapters/keycloak", { user: admin });
    expect(JSON.parse(adapter.out)).toEqual(api.body);
    const all = await settings(["show", "connections"]);
    expect(JSON.parse(all.out)).toEqual((await request("GET", "/api/v1/connections", { user: admin })).body);

    const [event] = await events("connection.created");
    expect(event).toMatchObject({
      actorId: null,
      actorLabel: "operator",
      details: { command: "cli settings apply connections" },
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it("lists every setting with hints, never a secret", async () => {
    const empty = await settings(["list"]);
    expect(empty.code).toBe(0);
    expect(empty.out).toMatch(/^app\s+not set\s+the defaults\nconnections\s+not set\s+no connections\n$/);

    const { out } = await settings(["apply", "connections"], KEYCLOAK);
    const id = JSON.parse(out).id as number;
    await makeConnection({ name: "Fake app", secretData: "" });
    await settings(["show", "app"]);
    await getDb().update(appSettings).set({ organizationName: "Example Organization" });
    const listed = await settings(["list"]);
    expect(listed.out).not.toContain(SECRET);
    // States and counts, no values: those are in `show app`.
    expect(listed.out).toMatch(
      /^app\s+set\s+automatic onboarding on; automatic offboarding on; task emails: 0 addresses; identity requests: 0 person types\n/,
    );
    expect(listed.out).not.toContain("Example Organization");
    expect(listed.out).toMatch(
      new RegExp(
        `connections --id ${id}\\s+set\\s+Keycloak \\(keycloak\\); off; automatic; test: untested; Client secret: saved`,
      ),
    );
    expect(listed.out).toMatch(
      /connections --id \d+\s+incomplete\s+Fake app \(fake\); on; .*Token: not saved/,
    );

    const rows = JSON.parse((await settings(["list", "--json"])).out);
    expect(rows).toContainEqual(expect.objectContaining({ name: "connections", id, state: "set" }));
    expect(rows[0]).toMatchObject({ name: "app", id: null, state: "set" });
  });

  it("keeps a saved secret that the body leaves out, and asks for it again when the server changes", async () => {
    const id = JSON.parse((await settings(["apply", "connections"], KEYCLOAK)).out).id as number;
    const edit = { ...KEYCLOAK, adapter: undefined, enabled: true, secrets: {} };

    const saved = await settings(["apply", "connections", "--id", String(id)], edit);
    expect(saved.code, saved.err).toBe(0);
    expect(saved.err).toBe("Saved Keycloak.\n");
    expect(JSON.parse(saved.out)).toMatchObject({ id, enabled: true, savedSecrets: ["client_secret"] });
    expect(secretsOf((await connectionById(id))!)).toEqual({ client_secret: SECRET });

    const moved = await settings(["apply", "connections", "--id", String(id)], {
      ...edit,
      settings: { ...edit.settings, base_url: "https://elsewhere.example.invalid" },
    });
    expect(moved.code).toBe(1);
    expect(moved.out).toBe("");
    expect(moved.err).toBe(
      "Check the highlighted fields\n  secrets.client_secret: Enter it again: Keycloak URL changed where it is sent.\n",
    );
    expect((await connectionById(id))!.settings.base_url).toBe("https://sso.example.invalid");

    const [event] = await events("connection.updated");
    expect(event).toMatchObject({
      actorLabel: "operator",
      details: { command: `cli settings apply connections --id ${id}` },
    });
  });

  it("refuses a body as the page does (exit 1) and a body that is not JSON (exit 2)", async () => {
    const invalid = await settings(["apply", "connections"], {
      ...KEYCLOAK,
      name: "",
      settings: { ...KEYCLOAK.settings, base_url: "not a url" },
    });
    expect(invalid.code).toBe(1);
    expect(invalid.err).toBe("Check the highlighted fields\n  name: This field is required.\n");
    const url = await settings(["apply", "connections"], {
      ...KEYCLOAK,
      settings: { ...KEYCLOAK.settings, base_url: "not a url" },
    });
    expect(url.err).toContain("  settings.base_url: Enter a valid URL.\n");
    const unknown = await settings(["apply", "connections"], { ...KEYCLOAK, adapter: "nonesuch" });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^Unknown adapter\. Adapters: keycloak, /);
    const missing = await settings(["apply", "connections", "--id", "99"], KEYCLOAK);
    expect(missing).toMatchObject({ code: 1, err: "No connection has the ID 99.\n" });
    expect((await settings(["apply", "connections", "--id", "99"], "{ broken")).code).toBe(2);

    // A key under `secrets` that no field has could itself be a secret.
    const pasted = await settings(["apply", "connections"], { ...KEYCLOAK, secrets: { [SECRET]: 1 } });
    expect(pasted).toMatchObject({ code: 1, out: "" });
    expect(pasted.err).toMatch(/^Check the highlighted fields\n {2}secrets\.\(not shown\): /);
    expect(pasted.err).not.toContain(SECRET);
    for (const adapter of ["keycloak", " keycloak "]) {
      const known = await settings(["apply", "connections"], {
        ...KEYCLOAK,
        adapter,
        secrets: { client_secret: 1 },
      });
      expect(known.err).toMatch(/^Check the highlighted fields\n {2}secrets\.client_secret: /);
    }

    // The parser's message would quote the body.
    const broken = await settings(["apply", "connections"], `{"secrets": {"client_secret": "${SECRET}"`);
    expect(broken.code).toBe(2);
    expect(broken.err).toContain("The body on stdin must be JSON.");
    expect(broken.err).not.toContain(SECRET);
    expect((await settings(["apply", "connections"], "")).code).toBe(2);
    expect(await getDb().select().from(connections)).toEqual([]);
  });

  it("never repeats an argument that could be a secret", async () => {
    for (const args of [
      ["apply", "connections", "--client_secret", SECRET],
      ["apply", "connections", `--client_secret=${SECRET}`],
      ["apply", "connections", SECRET],
      ["apply", SECRET],
      ["show", "connections", "--id", SECRET],
      ["show", "connections", "--adapter", SECRET],
      [SECRET],
    ]) {
      const result = await settings(args, KEYCLOAK);
      // An unknown adapter is the app's refusal; the rest are wrong commands.
      expect(result.code).toBe(args.includes("--adapter") ? 1 : 2);
      expect(result.out + result.err).not.toContain(SECRET);
    }
    expect(await getDb().select().from(connections)).toEqual([]);
  });

  it("removes a connection unless it is in use", async () => {
    const connection = await makeConnection();
    const removed = await settings(["remove", "connections", "--id", String(connection.id)]);
    expect(removed).toEqual({ code: 0, out: "", err: "Deleted Fake app.\n" });
    expect(await connectionById(connection.id)).toBeUndefined();
    expect((await events("connection.deleted"))[0]).toMatchObject({
      actorLabel: "operator",
      details: { command: `cli settings remove connections --id ${connection.id}` },
    });

    const used = await makeConnection();
    await makeProfile(used, []);
    const refused = await settings(["remove", "connections", "--id", String(used.id)]);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(
      "This connection has jobs or is used by access profiles. Turn it off instead.\n",
    );
    expect((await settings(["remove", "connections", "--id", "99"])).err).toBe(
      "No connection has the ID 99.\n",
    );
    expect((await settings(["remove", "connections"])).code).toBe(2);
    expect((await settings(["remove", "app", "--id", "1"])).code).toBe(2);
  });

  it("tests a connection as the test button does", async () => {
    const connection = await makeConnection({ status: "untested" });
    const passed = await settings(["test", "connections", "--id", String(connection.id)]);
    expect(passed.code, passed.err).toBe(0);
    expect(JSON.parse(passed.out)).toEqual({ ok: true, message: "Fake app with token 10 chars." });
    expect((await connectionById(connection.id))!.status).toBe("ok");
    expect((await events("connection.tested"))[0]).toMatchObject({
      actorLabel: "operator",
      details: { command: `cli settings test connections --id ${connection.id}` },
    });

    STORE.failWith = new AdapterError("The server refused the token.");
    const failed = await settings(["test", "connections", "--id", String(connection.id)]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toEqual({ ok: false, message: "The server refused the token." });
    expect(failed.err).toBe("The server refused the token.\n");
    expect((await connectionById(connection.id))!.status).toBe("error");

    STORE.failWith = new Error("boom");
    const crashed = await settings(["test", "connections", "--id", String(connection.id)]);
    expect(JSON.parse(crashed.out)).toEqual({ ok: false, message: "Unexpected error (Error)." });
    expect(logged).toContainEqual([
      { err: STORE.failWith, connectionId: connection.id },
      "connection test failed",
    ]);
    STORE.failWith = null;

    expect((await settings(["test", "app"])).code).toBe(2);
  });

  it("shows and saves Admin › Settings with the page's body and checks", async () => {
    const admin = await makeUser("admin");
    const shown = await settings(["show", "app"]);
    expect(JSON.parse(shown.out)).toEqual((await request("GET", "/api/v1/settings", { user: admin })).body);

    const body = {
      ...JSON.parse(shown.out),
      organizationName: "Example",
      identityRequestTypes: ["intern", "employee"],
    };
    const saved = await settings(["apply", "app"], body);
    expect(saved.err).toBe("Saved the settings.\n");
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.out)).toEqual({ ...body, identityRequestTypes: ["employee", "intern"] });
    expect((await events("settings.saved"))[0]).toMatchObject({
      actorLabel: "operator",
      details: { command: "cli settings apply app", fields: ["identity_request_types", "organization_name"] },
    });

    const refused = await settings(["apply", "app"], { ...body, onboardingLeadDays: -1 });
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(
      "Check the highlighted fields\n  onboardingLeadDays: Ensure this value is greater than or equal to 0.\n",
    );
    expect((await settings(["apply", "app", "--id", "1"], body)).code).toBe(2);
  });

  it("creates an API key as the page does, alone on stdout", async () => {
    const created = await tokens(["create", "api-key", "--name", "Helpdesk"]);
    expect(created.code, created.err).toBe(0);
    expect(created.out).toMatch(/^iam_[A-Za-z0-9_-]+\n$/);
    const key = created.out.trim();
    expect(created.err).not.toContain(key);
    expect(created.err).toContain("Created the key. Copy it now: it is shown only once.");
    const [saved] = await getDb().select().from(apiKeys);
    expect(saved).toMatchObject({ name: "Helpdesk", keyHash: hashApiKey(key), createdById: null });
    expect((await apiKeyFrom(`Bearer ${key}`))?.id).toBe(saved!.id);
    expect((await events("api_key.created"))[0]).toMatchObject({
      actorLabel: "operator",
      details: { command: "cli tokens create api-key", prefix: saved!.prefix },
    });

    const listed = await tokens(["list"]);
    expect(listed.out).not.toContain(key);
    expect(listed.out).toMatch(
      new RegExp(`^api-key ${saved!.id}\\s+active\\s+Helpdesk; ${saved!.prefix}…; created `),
    );
    const page = await request("GET", "/api/v1/api-keys", { user: await makeUser("admin") });
    expect(page.body).toMatchObject([{ id: saved!.id, createdBy: "Operator" }]);
    expect(JSON.parse((await tokens(["list", "--json"])).out)).toEqual(page.body);

    expect(await tokens(["revoke", String(saved!.id)])).toEqual({
      code: 0,
      out: "",
      err: 'Revoked the key "Helpdesk".\n',
    });
    expect(await apiKeyFrom(`Bearer ${key}`)).toBeNull();
    expect((await tokens(["revoke", String(saved!.id)])).err).toBe("This key is already revoked.\n");
    expect((await tokens(["revoke", "99"])).err).toBe("No API key has the ID 99.\n");
  });

  it("refuses tokens it cannot create", async () => {
    expect((await tokens(["create", "api-key"])).code).toBe(2);
    expect(await tokens(["create", "api-key", "--name", " "])).toMatchObject({
      code: 1,
      err: "Check the highlighted fields\n  name: This field is required.\n",
    });
    expect((await tokens(["create", "service-token", "--name", "x"])).code).toBe(2);
    expect((await tokens(["revoke"])).code).toBe(2);
    expect(await getDb().select().from(apiKeys)).toEqual([]);
  });
});
