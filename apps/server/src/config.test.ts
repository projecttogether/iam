import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NO_DATA_COLLECTION } from "@iam/shared/error-reports";
import { config, resetConfigForTests } from "./config";
import { connectionOptions } from "./db/client";
import { errorReportRelease, withErrorReportingSettings } from "./error-reporting";
import { createApp } from "./http/app";

const original = { ...process.env };

function configWith(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
  return () => config();
}

const KEY = "zIi4BBQnf3ojuqE3UQQ1yUmP0zpMlTv44ATyCo-nt9E=";

describe("config", () => {
  afterEach(() => {
    process.env = { ...original };
    resetConfigForTests();
  });

  it("needs the secrets in production", () => {
    expect(
      configWith({
        NODE_ENV: "production",
        APP_URL: "https://iam.example.invalid",
        AUTH_SECRET: undefined,
        ENCRYPTION_KEY: undefined,
      }),
    ).toThrow(/AUTH_SECRET: Set a random secret[\s\S]*ENCRYPTION_KEY: Set a Fernet key/);
  });

  it("names APP_URL and AUTH_SECRET when compose.yaml passes them empty: neither name is in .env", () => {
    expect(
      configWith({
        NODE_ENV: "production",
        APP_URL: "",
        AUTH_SECRET: "",
        CSRF_TRUSTED_ORIGINS: undefined,
        DJANGO_SECRET_KEY: undefined,
        ENCRYPTION_KEY: KEY,
      }),
    ).toThrow(/APP_URL: Set the public URL[\s\S]*AUTH_SECRET: Set a random secret/);
  });

  it("reads the variables of the Django version", () => {
    const settings = configWith({
      NODE_ENV: "production",
      APP_URL: undefined,
      AUTH_SECRET: undefined,
      CSRF_TRUSTED_ORIGINS: "https://*.example.invalid/, https://iam.example.invalid/",
      DJANGO_SECRET_KEY: "x".repeat(50),
      ENCRYPTION_KEY: KEY,
    })();
    expect(settings.APP_URL).toBe("https://iam.example.invalid");
    expect(settings.AUTH_SECRET).toBe("x".repeat(50));
  });

  it("refuses to guess the public URL from several origins or only wildcards", () => {
    const django = { NODE_ENV: "production", APP_URL: undefined, ENCRYPTION_KEY: KEY };
    expect(
      configWith({
        ...django,
        CSRF_TRUSTED_ORIGINS: "http://localhost:8000,https://iam.example.invalid",
      }),
    ).toThrow(/APP_URL: CSRF_TRUSTED_ORIGINS \(Django version\) names several addresses/);
    expect(configWith({ ...django, CSRF_TRUSTED_ORIGINS: "https://*.example.invalid" })).toThrow(
      /APP_URL: CSRF_TRUSTED_ORIGINS \(Django version\) names only origins with a wildcard/,
    );
    // compose.yaml passes the list as APP_URL while APP_URL is unset.
    expect(configWith({ ...django, APP_URL: "https://*.example.invalid" })).toThrow(
      /APP_URL: APP_URL names only origins with a wildcard/,
    );
    expect(
      configWith({ ...django, APP_URL: "https://*.example.invalid/,https://iam.example.invalid" })().APP_URL,
    ).toBe("https://iam.example.invalid");
  });

  it("needs Fernet keys", () => {
    expect(configWith({ ENCRYPTION_KEY: "not-a-key" })).toThrow(/ENCRYPTION_KEY: Must be Fernet keys/);
    expect(configWith({ ENCRYPTION_KEY: `${KEY},${KEY}` })().encryptionKeys).toEqual([KEY, KEY]);
  });

  it("refuses a read-only value that is no clear yes or no", () => {
    expect(configWith({ READ_ONLY: "maybe" })).toThrow(/READ_ONLY: Must be 1 or 0/);
    expect(configWith({ READ_ONLY: "yes" })().READ_ONLY).toBe(true);
    expect(configWith({ READ_ONLY: "" })().READ_ONLY).toBe(false);
  });

  it("builds the issuer from Keycloak's URL and realm", () => {
    const settings = configWith({
      OIDC_ISSUER: undefined,
      KEYCLOAK_URL: "https://sso.example.invalid/",
      KEYCLOAK_REALM: "staff",
    })();
    expect(settings.oidcIssuer).toBe("https://sso.example.invalid/realms/staff");
    expect(settings.oidcProviderKind).toBe("keycloak");
    expect(settings.oidcProviderName).toBe("Keycloak");
  });

  it("reads the role groups and bootstrap admins", () => {
    const settings = configWith({
      OIDC_ADMIN_GROUPS: " /iam/admins , admins",
      BOOTSTRAP_ADMIN_EMAILS: " Ada@Example.invalid ",
    })();
    expect(settings.adminGroups).toEqual(["/iam/admins", "admins"]);
    expect(settings.bootstrapAdminEmails).toEqual(["ada@example.invalid"]);
  });

  it("allows the development sign-in only in development", () => {
    expect(
      configWith({
        NODE_ENV: "production",
        APP_URL: "https://iam.example.invalid",
        ENCRYPTION_KEY: KEY,
        DEV_LOGIN: "1",
      }),
    ).toThrow(/DEV_LOGIN: Only for NODE_ENV=development/);
  });

  it("needs HTTPS in production, except on this machine", () => {
    const production = { NODE_ENV: "production", ENCRYPTION_KEY: KEY, AUTH_SECRET: "x".repeat(40) };
    expect(configWith({ ...production, APP_URL: "http://iam.example.invalid" })).toThrow(
      /APP_URL: Must be an https/,
    );
    expect(configWith({ ...production, APP_URL: "http://localhost:8000" })().APP_URL).toBe(
      "http://localhost:8000",
    );
    expect(configWith({ ...production, APP_URL: "https://iam.example.invalid" })().HOST).toBe("0.0.0.0");
    expect(configWith({ NODE_ENV: "development", HOST: undefined })().HOST).toBe("127.0.0.1");
  });

  it("writes the scheme and host of APP_URL in lower case", () => {
    const settings = configWith({ APP_URL: "HTTPS://IAM.Example.invalid/" })();
    expect(settings.APP_URL).toBe("https://iam.example.invalid");
    // As openid-client sends the callback URL at the code exchange.
    expect(configWith({ APP_URL: "https://iam.example.invalid:443" })().APP_URL).toBe(
      "https://iam.example.invalid",
    );
    expect(configWith({ APP_URL: "https://iam.example.invalid:8443" })().APP_URL).toBe(
      "https://iam.example.invalid:8443",
    );
  });

  it("checks the time zone", () => {
    expect(configWith({ TZ: "Europe/Berlin" })().TZ).toBe("Europe/Berlin");
    expect(configWith({ TZ: "Mars/Olympus" })).toThrow(/Not a time zone/);
  });
});

/**
 * Port of tests/test_settings.py: deployment settings. The Django version
 * read them in config/settings.py; here config(), the database client,
 * error reporting (instrument.ts) and the app's headers do.
 */
describe("deployment settings", () => {
  const PRODUCTION = {
    NODE_ENV: "production",
    AUTH_SECRET: "x".repeat(50),
    ENCRYPTION_KEY: KEY,
    APP_URL: "https://iam.example.invalid",
    APP_VERSION: "1.2.3",
    OIDC_ISSUER: undefined,
    KEYCLOAK_URL: "https://sso.example.invalid",
    KEYCLOAK_REALM: "staff",
  };

  /** The Sentry settings the web app gets (the server's own come from the same variables, see below). */
  function webErrorReporting() {
    const html = withErrorReportingSettings("<head></head>");
    const content = /content="([^"]*)"/.exec(html)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const { environment, release } = JSON.parse(content) as { environment: string; release?: string };
    return { environment, release };
  }

  afterEach(() => {
    process.env = { ...original };
    resetConfigForTests();
  });

  it("keeps the defaults for the empty variables compose passes", () => {
    const settings = configWith({
      ...PRODUCTION,
      SENTRY_DSN: "https://public@sentry.example.invalid/1",
      SENTRY_RELEASE: "",
      SENTRY_ENVIRONMENT: "",
      OIDC_PROVIDER_NAME: "",
      SESSION_HOURS: "",
      SECURE_SSL_REDIRECT: "",
      OIDC_SCOPES: "",
    })();
    expect({
      release: errorReportRelease(settings),
      web: webErrorReporting(),
      providerName: settings.oidcProviderName,
      sessionHours: settings.SESSION_HOURS,
      scopes: settings.OIDC_SCOPES,
    }).toEqual({
      release: "iam@1.2.3",
      web: { release: "iam@1.2.3", environment: "production" },
      providerName: "Keycloak",
      sessionHours: 12,
      scopes: "openid email profile",
    });
  });

  it("sends HSTS for an https APP_URL (SECURE_SSL_REDIRECT has no counterpart: the proxy redirects)", async () => {
    configWith({ ...PRODUCTION, SECURE_SSL_REDIRECT: "" })();
    const response = await createApp().request("/-/healthz");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("lets set variables win over the defaults", () => {
    const settings = configWith({
      ...PRODUCTION,
      SENTRY_DSN: "https://public@sentry.example.invalid/1",
      SENTRY_RELEASE: "custom",
      SENTRY_ENVIRONMENT: "staging-eu",
      OIDC_PROVIDER_NAME: "Staff login",
    })();
    expect(errorReportRelease(settings)).toBe("custom");
    expect(webErrorReporting()).toMatchObject({ release: "custom", environment: "staging-eu" });
    expect(settings.oidcProviderName).toBe("Staff login");
  });

  it("reports errors to Sentry without request data, people or provider addresses", () => {
    // A server process with Sentry on: a request fails (the database is
    // down), another warns (the provider is down). Both carry a code, a search,
    // a health token, a referrer and a session cookie, none of which may leave.
    const script = `
      const Sentry = await import("@sentry/node");
      await import("./src/instrument.ts");
      const items = [];
      Sentry.getClient().on("beforeEnvelope", (envelope) => {
        for (const [header, payload] of envelope[1]) if (header.type !== "client_report") items.push({ type: header.type, payload });
      });
      const { serve } = await import("@hono/node-server");
      const { createApp } = await import("./src/http/app.ts");
      const server = await new Promise((resolve) => {
        const started = serve({ fetch: createApp().fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(started));
      });
      const base = "http://127.0.0.1:" + server.address().port;
      const headers = {
        "x-health-token": "sample-header",
        referer: "https://iam.example.invalid/people?q=sample-referrer",
        cookie: "__Host-iam_session=sample-session",
      };
      const statuses = [
        (await fetch(base + "/api/v1/me?q=sample-search", { headers })).status,
        (await fetch(base + "/oidc/authenticate/?next=%2Fpeople%3Fq%3Dsample-next", { headers, redirect: "manual" })).status,
      ];
      await Sentry.flush(5000);
      server.close();
      const options = Sentry.getClient().getOptions();
      process.stdout.write("\\nRESULT " + JSON.stringify({
        statuses, items, dataCollection: options.dataCollection, maxBreadcrumbs: options.maxBreadcrumbs,
      }) + "\\n");
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        PATH: process.env.PATH ?? "",
        ...PRODUCTION,
        OIDC_ISSUER: "https://sso.example.invalid/realms/staff",
        OIDC_CLIENT_ID: "iam",
        DATABASE_URL: "postgres://iam:secret@127.0.0.1:9/iam",
        SENTRY_DSN: "http://public@127.0.0.1:9/1",
        SENTRY_TRACES_SAMPLE_RATE: "1",
        SENTRY_RELEASE: "",
        SENTRY_ENVIRONMENT: "",
        LOG_LEVEL: "info",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const line = result.stdout.split("\n").find((text) => text.startsWith("RESULT "));
    expect(line, result.stderr).toBeDefined();
    const output = line!.slice("RESULT ".length);
    const { statuses, items, dataCollection, maxBreadcrumbs } = JSON.parse(output) as {
      statuses: number[];
      items: { type: string; payload: Record<string, unknown> }[];
      dataCollection: unknown;
      maxBreadcrumbs: number;
    };
    expect(statuses).toEqual([500, 302]);
    const events = items.filter((item) => item.type === "event").map((item) => item.payload);
    expect(events.length).toBeGreaterThan(0);
    expect(items.some((item) => item.type === "span")).toBe(true);
    expect(items.some((item) => item.type === "log")).toBe(true);
    for (const event of events) {
      // Stricter than the Django version, which kept the URL without its query and the method.
      expect(event.request).toBeUndefined();
      expect(event).toMatchObject({ environment: "production", release: "iam@1.2.3" });
    }
    expect(output).not.toContain("sample-");
    // Calls to the provider (and to connected apps) carry addresses in paths and filters: no spans or breadcrumbs.
    expect(output).not.toContain("sso.example.invalid");
    expect(dataCollection).toEqual(NO_DATA_COLLECTION);
    expect(maxBreadcrumbs).toBe(0);
  }, 60_000);

  it("keeps database connections through restarts and failovers", () => {
    configWith({ DATABASE_URL: "postgresql://iam:secret@db.example.invalid/iam?connect_timeout=3" });
    // A value in the URL wins; the others bound how long a dead server can hold a request.
    expect(connectionOptions()).toMatchObject({ connectionTimeoutMillis: 3_000, keepAlive: true });
    configWith({ DATABASE_URL: "postgresql://iam:secret@db.example.invalid/iam" });
    const options = connectionOptions();
    expect(options).toMatchObject({ connectionTimeoutMillis: 10_000, keepAlive: true });
    expect(options.keepAliveInitialDelayMillis).toBeLessThanOrEqual(30_000);
  });
});
