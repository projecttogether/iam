import { generateKeyPairSync, verify } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError } from "../adapters/base";
import { config, overrideConfigForTests } from "../config";
import { generateKey } from "../core/crypto";
import { getDb } from "../db/client";
import { auditEvents, connections, providerGroups, syncRuns, type Connection } from "../db/schema";
import { buildAdapter, secretsOf } from "../engine/connections";
import { STORE } from "../test/fake-adapter";
import { makeConnection, makeUser, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";
import { json, mockFetch } from "../test/mock-fetch";

/**
 * Port of tests/test_views.py: the connection pages. Secrets are
 * write-only: no answer carries a saved or submitted secret. Form errors are
 * 422 with `error.fields` (`settings.<name>`, `secrets.<name>`).
 */

async function connectionNamed(name: string): Promise<Connection> {
  const [connection] = await getDb().select().from(connections).where(eq(connections.name, name));
  return connection!;
}

async function connectionById(id: number): Promise<Connection> {
  const [connection] = await getDb().select().from(connections).where(eq(connections.id, id));
  return connection!;
}

const KEYCLOAK_SETTINGS = {
  base_url: "https://sso.example.invalid",
  realm: "example",
  client_id: "iam-admin",
  username_source: "username",
  setup_email_lifespan_hours: "72",
  sync_interval_minutes: "360",
};

describe("connections", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("keeps connection secrets write-only", async () => {
    const admin = await makeUser("admin");
    const created = await request("POST", "/api/v1/connections", {
      user: admin,
      body: {
        adapter: "keycloak",
        name: "Keycloak",
        enabled: false,
        mode: "automatic",
        settings: { ...KEYCLOAK_SETTINGS, send_setup_email: true },
        secrets: { client_secret: "very-secret-value" },
      },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.text).not.toContain("very-secret-value");
    let connection = await connectionNamed("Keycloak");
    expect(connection.secretData).not.toContain("very-secret-value");
    expect(secretsOf(connection)).toEqual({ client_secret: "very-secret-value" });
    expect(connection.settings).not.toHaveProperty("client_secret");
    expect(connection.settings.send_setup_email).toBe(true);
    expect(connection.enabled).toBe(false);

    const form = await request("GET", `/api/v1/connections/${connection.id}/form`, { user: admin });
    expect(form.text).not.toContain("very-secret-value");
    // The form says the secret is saved ("Leave empty to keep it").
    expect(form.body.savedSecrets).toEqual(["client_secret"]);
    const detail = await request("GET", `/api/v1/connections/${connection.id}`, { user: admin });
    expect(detail.text).not.toContain("very-secret-value");

    const saved = await request("PUT", `/api/v1/connections/${connection.id}`, {
      user: admin,
      body: {
        name: "Keycloak",
        enabled: true,
        mode: "automatic",
        settings: { ...KEYCLOAK_SETTINGS, realm: "other" },
        secrets: { client_secret: "" },
      },
    });
    expect(saved.status, saved.text).toBe(200);
    connection = await connectionById(connection.id);
    expect(connection.enabled).toBe(true);
    expect(connection.settings.realm).toBe("other");
    expect(secretsOf(connection)).toEqual({ client_secret: "very-secret-value" });
    const events = await getDb().select().from(auditEvents).where(like(auditEvents.action, "connection.%"));
    for (const event of events) {
      expect(JSON.stringify(event.details) + event.summary).not.toContain("very-secret-value");
    }
    const [updated] = events.filter((event) => event.action === "connection.updated");
    const changed = updated!.details.settings_changed as string[];
    expect(changed).toContain("realm");
    expect(changed).not.toContain("client_secret");
  });

  it("keeps secrets write-only in an invalid form", async () => {
    const admin = await makeUser("admin");
    for (const name of ["", "Google"]) {
      const response = await request("POST", "/api/v1/connections", {
        user: admin,
        body: {
          adapter: "google_workspace",
          name,
          enabled: false,
          settings: {},
          secrets: { service_account_json: "submitted-key-placeholder" },
        },
      });
      expect(response.status, name).toBe(422);
      expect(response.text, name).not.toContain("submitted-key-placeholder");
    }
    expect(await getDb().select().from(connections)).toEqual([]);
  });

  it.each([[""], [" "]])(
    "reads a Google key pasted without its line breaks (joined by %j)",
    async (lineBreak) => {
      // Browsers drop the line breaks of a value pasted into the secret field
      // (Firefox turns them into spaces). The key's JSON still reads.
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const keyFile = JSON.stringify(
        {
          type: "service_account",
          client_email: "iam@project.example.invalid",
          private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
          token_uri: "https://oauth2.googleapis.com/token",
        },
        null,
        2,
      );
      const pasted = keyFile.split("\n").join(lineBreak);
      const admin = await makeUser("admin");
      const response = await request("POST", "/api/v1/connections", {
        user: admin,
        body: {
          adapter: "google_workspace",
          name: "Google",
          enabled: false,
          mode: "automatic",
          settings: {
            admin_email: "admin@example.invalid",
            domain: "example.invalid",
            customer_id: "my_customer",
            org_unit_path: "/",
            sync_interval_minutes: "360",
          },
          secrets: { service_account_json: pasted },
        },
      });
      expect(response.status, response.text).toBe(201);
      // Google signs the service account in when the assertion carries the key's signature.
      const fetch = mockFetch((seen) => {
        const [header, claims, signature] = seen.form().get("assertion")!.split(".");
        const signed = verify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature!, "base64url"),
        );
        return signed ? json(200, { access_token: "signed-in" }) : json(400, { error: "invalid_grant" });
      });
      const adapter = buildAdapter(await connectionNamed("Google"), { fetch });
      expect(await (adapter as unknown as { accessToken(): Promise<string> }).accessToken()).toBe(
        "signed-in",
      );
      expect(fetch.requests.map((seen) => seen.url.href)).toEqual(["https://oauth2.googleapis.com/token"]);
    },
  );

  it("asks for a saved secret again when its URL changes", async () => {
    // Otherwise an admin session could send a stored secret to any server.
    const admin = await makeUser("admin");
    const fake = await makeConnection();
    const url = `/api/v1/connections/${fake.id}`;
    const data = {
      name: "Fake app",
      enabled: false,
      mode: "automatic",
      settings: { sync_interval_minutes: "0" },
    };
    expect(
      (await request("PUT", url, { user: admin, body: { ...data, secrets: { token: "" } } })).status,
    ).toBe(200);
    const moved = { ...data, settings: { ...data.settings, url: "https://elsewhere.example.invalid" } };
    const refused = await request("PUT", url, { user: admin, body: { ...moved, secrets: { token: "" } } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields["secrets.token"]).toContain("Enter it again");
    expect((await connectionById(fake.id)).settings.url ?? "").toBe("");

    expect(
      (await request("PUT", url, { user: admin, body: { ...moved, secrets: { token: "new-token" } } }))
        .status,
    ).toBe(200);
    let connection = await connectionById(fake.id);
    expect(connection.settings.url).toBe("https://elsewhere.example.invalid");
    expect(secretsOf(connection)).toEqual({ token: "new-token" });
    // Unchanged, the saved secret stays.
    expect(
      (await request("PUT", url, { user: admin, body: { ...moved, secrets: { token: "" } } })).status,
    ).toBe(200);
    connection = await connectionById(fake.id);
    expect(secretsOf(connection)).toEqual({ token: "new-token" });
  });

  it("asks for the SMTP password again when the server changes", async () => {
    const admin = await makeUser("admin");
    const data = {
      name: "Mail",
      enabled: false,
      settings: {
        host: "smtp.example.invalid",
        port: "587",
        security: "starttls",
        username: "iam",
        from_address: "it@example.invalid",
      },
    };
    const created = await request("POST", "/api/v1/connections", {
      user: admin,
      body: { ...data, adapter: "smtp", secrets: { password: "mail-password" } },
    });
    expect(created.status, created.text).toBe(201);
    const connection = await connectionNamed("Mail");
    const url = `/api/v1/connections/${connection.id}`;
    const kept = { ...data, secrets: { password: "" } };
    for (const change of [{ host: "mail.example.invalid" }, { security: "none" }, { port: "25" }]) {
      const response = await request("PUT", url, {
        user: admin,
        body: { ...kept, settings: { ...kept.settings, ...change } },
      });
      expect(response.status, JSON.stringify(change)).toBe(422);
      expect(response.body.error.fields["secrets.password"], JSON.stringify(change)).toContain(
        "Enter it again",
      );
    }
    const named = await request("PUT", url, {
      user: admin,
      body: { ...kept, settings: { ...kept.settings, from_name: "IT team" } },
    });
    expect(named.status).toBe(200);
    expect(secretsOf(await connectionById(connection.id))).toEqual({ password: "mail-password" });
  });

  it("lets secrets no key can read be entered again", async () => {
    // A lost ENCRYPTION_KEY must not turn the edit form into an error.
    const admin = await makeUser("admin");
    const fake = await makeConnection();
    const keys = config().encryptionKeys;
    overrideConfigForTests({ encryptionKeys: [generateKey()] });
    try {
      const url = `/api/v1/connections/${fake.id}`;
      const form = await request("GET", `${url}/form`, { user: admin });
      expect(form.status).toBe(200);
      expect(form.body.savedSecrets).toEqual([]);
      const data = {
        name: "Fake app",
        enabled: false,
        mode: "automatic",
        settings: { sync_interval_minutes: "0" },
      };
      const refused = await request("PUT", url, { user: admin, body: { ...data, secrets: { token: "" } } });
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields["secrets.token"]).toBe("This field is required.");
      expect(
        (await request("PUT", url, { user: admin, body: { ...data, secrets: { token: "new-token" } } }))
          .status,
      ).toBe(200);
      expect(secretsOf(await connectionById(fake.id))).toEqual({ token: "new-token" });
    } finally {
      overrideConfigForTests({ encryptionKeys: keys });
    }
  });

  it("records the result of a connection test", async () => {
    const admin = await makeUser("admin");
    const fake = await makeConnection();
    expect(
      (await request("POST", `/api/v1/connections/${fake.id}/test`, { user: admin, body: {} })).status,
    ).toBe(200);
    let connection = await connectionById(fake.id);
    expect(connection.status).toBe("ok");
    expect(connection.statusMessage).toContain("10 chars");

    STORE.failWith = new ConfigurationError("Token refused.");
    const failed = await request("POST", `/api/v1/connections/${fake.id}/test`, { user: admin, body: {} });
    expect(failed.body).toEqual({ ok: false, message: "Token refused." });
    connection = await connectionById(fake.id);
    expect(connection.status).toBe("error");
    expect(connection.statusMessage).toBe("Token refused.");
  });

  it("imports groups and compares accounts from the connection page", async () => {
    const admin = await makeUser("admin");
    const fake = await makeConnection();
    expect(
      (await request("POST", `/api/v1/connections/${fake.id}/import-groups`, { user: admin, body: {} })).body
        .ok,
    ).toBe(true);
    expect(
      await getDb().select().from(providerGroups).where(eq(providerGroups.connectionId, fake.id)),
    ).toHaveLength(3);
    expect(
      (await request("POST", `/api/v1/connections/${fake.id}/sync`, { user: admin, body: {} })).body.ok,
    ).toBe(true);
    const runs = await getDb()
      .select()
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.connectionId, fake.id),
          eq(syncRuns.kind, "accounts"),
          eq(syncRuns.status, "succeeded"),
        ),
      );
    expect(runs).toHaveLength(1);
  });

  it("adds and removes manual groups", async () => {
    const admin = await makeUser("admin");
    const figma = await makeConnection({
      adapter: "manual",
      name: "Figma",
      settings: { app_name: "Figma" },
      secretData: "",
    });
    const added = await request("POST", `/api/v1/connections/${figma.id}/groups`, {
      user: admin,
      body: { name: "Editors" },
    });
    expect(added.status).toBe(200);
    const [group, ...others] = await getDb()
      .select()
      .from(providerGroups)
      .where(eq(providerGroups.connectionId, figma.id));
    expect(others).toEqual([]);
    expect(group!.manual).toBe(true);
    expect(group!.name).toBe("Editors");
    const removed = await request("DELETE", `/api/v1/connections/${figma.id}/groups/${group!.id}`, {
      user: admin,
    });
    expect(removed.status).toBe(200);
    expect(
      await getDb().select().from(providerGroups).where(eq(providerGroups.connectionId, figma.id)),
    ).toEqual([]);
  });

  it("offers no group import for SCIM without groups", async () => {
    const admin = await makeUser("admin");
    const detail = async (connection: Connection) =>
      (await request("GET", `/api/v1/connections/${connection.id}`, { user: admin })).body;
    const scim = await makeConnection({
      adapter: "scim",
      name: "SCIM app",
      settings: { groups_enabled: false },
    });
    expect(await detail(scim)).toMatchObject({ supportsGroups: false, canImportGroups: false });
    const withGroups = await makeConnection({
      adapter: "scim",
      name: "SCIM groups",
      settings: { groups_enabled: true },
    });
    expect((await detail(withGroups)).canImportGroups).toBe(true);
    const manual = await makeConnection({ adapter: "manual", name: "Manual", settings: {}, secretData: "" });
    expect(await detail(manual)).toMatchObject({ supportsGroups: true, canImportGroups: false });
  });

  it("fits the external ID of a long manual group name", async () => {
    const admin = await makeUser("admin");
    const figma = await makeConnection({ adapter: "manual", name: "Figma", settings: {}, secretData: "" });
    for (const name of ["x".repeat(300), "İ".repeat(300)]) {
      const response = await request("POST", `/api/v1/connections/${figma.id}/groups`, {
        user: admin,
        body: { name },
      });
      expect(response.status, name.slice(0, 1)).toBe(200);
    }
    const groups = await getDb()
      .select()
      .from(providerGroups)
      .where(eq(providerGroups.connectionId, figma.id));
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(group.externalId.length).toBeLessThanOrEqual(255);
    const long = groups.find((group) => group.name.startsWith("x"))!;
    expect(long.name).toBe("x".repeat(255));
  });
});
