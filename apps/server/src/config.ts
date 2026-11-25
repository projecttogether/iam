import { z } from "zod";

/**
 * Settings from the environment. Read them only through `config()`; blank
 * values count as unset (compose.yaml passes optional variables as empty
 * strings). Document every variable in docs/configuration.md. Everything an
 * admin changes while the app runs (connections, users, lifecycle rules)
 * lives in the database.
 *
 * Variables of the Django version (0.1, 0.2) still work, so an existing
 * `.env` needs no change: DJANGO_SECRET_KEY for AUTH_SECRET, the first
 * CSRF_TRUSTED_ORIGINS entry for APP_URL.
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(fallback as never));
const YES = ["1", "true", "yes", "on"];
const NO = ["0", "false", "no", "off"];
const flag = (fallback: boolean) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== "" ? YES.includes(value.trim().toLowerCase()) : undefined,
    z.boolean().default(fallback),
  );
/**
 * A yes or no that must be one: any other value stops the app, so a typo
 * can never turn read-only mode off.
 */
const strictFlag = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() || "0" : "0"),
  z
    .string()
    .refine((value) => YES.includes(value) || NO.includes(value), "Must be 1 or 0")
    .transform((value) => YES.includes(value)),
);
const list = withDefault(z.string(), "");

/** Example values (.env.example): never valid where the app is in use. */
const EXAMPLE_SECRETS = new Set(["development-secret-development-secret-development"]);

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "production"),
    /** Which part of the application this process runs. */
    APP_ROLE: withDefault(z.enum(["all", "web", "worker", "migrate"]), "all"),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535), 8000),
    /** The address the web process listens on: all in production (the image), only this machine in development. */
    HOST: optional(z.string()),
    /**
     * The public URL of the app, e.g. https://iam.example.invalid. A list (as
     * compose.yaml passes CSRF_TRUSTED_ORIGINS of the Django version): its one
     * entry without a wildcard (publicUrl).
     */
    APP_URL: optional(z.string()),
    /** Django version: the public origins. Stands in for APP_URL (publicUrl). */
    CSRF_TRUSTED_ORIGINS: optional(z.string()),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_SIZE: withDefault(z.coerce.number().int().min(1).max(200), 10),
    /** Longest database statement of the web app and the worker, in seconds; 0: no limit. */
    DATABASE_STATEMENT_TIMEOUT_SECONDS: withDefault(z.coerce.number().int().min(0).max(86_400), 60),
    /** Signs sessions and the sign-in state. At least 32 characters. */
    AUTH_SECRET: optional(z.string()),
    /** Django version: the same secret under its old name. */
    DJANGO_SECRET_KEY: optional(z.string()),
    /**
     * Fernet keys that encrypt connection secrets, comma-separated. The first
     * encrypts; all decrypt (rotation: docs/configuration.md).
     */
    ENCRYPTION_KEY: optional(z.string()),
    LOG_LEVEL: withDefault(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), "info"),
    /** Apply database migrations when the process starts (single-container setups). */
    RUN_MIGRATIONS: flag(false),
    /** Directory with the built web app. */
    WEB_DIST_DIR: optional(z.string()),
    MIGRATIONS_DIR: optional(z.string()),
    /** The time zone of dates, start and end days, and the schedule. */
    TZ: withDefault(z.string(), "UTC"),
    /** Sign-in: any OpenID Connect provider (OIDC_ISSUER), or Keycloak by base URL and realm. */
    OIDC_ISSUER: optional(z.string()),
    KEYCLOAK_URL: optional(z.string()),
    KEYCLOAK_REALM: optional(z.string()),
    OIDC_CLIENT_ID: withDefault(z.string(), ""),
    OIDC_CLIENT_SECRET: withDefault(z.string(), ""),
    OIDC_PROVIDER_NAME: optional(z.string().max(60)),
    OIDC_SCOPES: withDefault(z.string(), "openid email profile"),
    OIDC_SIGN_ALGO: withDefault(z.string().regex(/^(RS|ES|PS|HS)(256|384|512)$|^EdDSA$/), "RS256"),
    OIDC_GROUPS_CLAIM: withDefault(z.string().min(1).max(100), "groups"),
    OIDC_ADMIN_GROUPS: list,
    OIDC_APPROVER_GROUPS: list,
    OIDC_VIEWER_GROUPS: list,
    /** Verified addresses that may claim the first admin while no active admin exists. */
    BOOTSTRAP_ADMIN_EMAILS: list,
    /** Only for providers without a discovery document; they win over its values. */
    OIDC_AUTHORIZATION_ENDPOINT: optional(z.string()),
    OIDC_TOKEN_ENDPOINT: optional(z.string()),
    OIDC_USERINFO_ENDPOINT: optional(z.string()),
    OIDC_JWKS_ENDPOINT: optional(z.string()),
    /** Sessions end this many hours after sign-in. */
    SESSION_HOURS: withDefault(z.coerce.number().int().min(1).max(720), 12),
    /** Development only: sign in as any app user without a provider. */
    DEV_LOGIN: flag(false),
    /** Send HSTS for subdomains too (with an https APP_URL). */
    SECURE_HSTS_INCLUDE_SUBDOMAINS: flag(true),
    /** Shows details on /-/readyz for requests with X-Health-Token. */
    HEALTHCHECK_TOKEN: withDefault(z.string(), ""),
    WORKER_POLL_SECONDS: withDefault(z.coerce.number().min(0.1).max(3600), 5),
    WORKER_HEARTBEAT_MAX_AGE_SECONDS: withDefault(z.coerce.number().int().min(10), 300),
    /** A worker without progress for this long is stuck; it ends so that it restarts. */
    WORKER_STALL_SECONDS: withDefault(z.coerce.number().int().min(30), 600),
    /** The worker touches this file while it makes progress, for the container's health check. */
    WORKER_ALIVE_FILE: withDefault(z.string(), "/tmp/iam-worker-alive"),
    /** A running job whose worker stopped runs again after this. */
    JOB_LEASE_SECONDS: withDefault(z.coerce.number().int().min(10), 300),
    /** Timeout of each call to a connected app. */
    PROVIDER_TIMEOUT_SECONDS: withDefault(z.coerce.number().min(1).max(600), 20),
    /** Read connected apps, change nothing in them, send no email (docs/architecture.md). */
    READ_ONLY: strictFlag,
    /** The version of an image of the Deploy workflow (the first 12 characters of its commit); unset in images built from source. */
    APP_VERSION: optional(z.string().max(100)),
    /** Error reports and performance data to Sentry or a compatible service; off when unset. */
    SENTRY_DSN: optional(z.url()),
    SENTRY_ENVIRONMENT: optional(z.string().max(64)),
    SENTRY_RELEASE: optional(z.string().max(200)),
    /** Share of requests and page loads traced for performance data, 0 to 1. */
    SENTRY_TRACES_SAMPLE_RATE: withDefault(z.coerce.number().min(0).max(1), 0),
  })
  .superRefine((value, ctx) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.TZ });
    } catch {
      ctx.addIssue({ code: "custom", path: ["TZ"], message: `Not a time zone: ${value.TZ}` });
    }
    if (value.NODE_ENV !== "development" && value.DEV_LOGIN) {
      ctx.addIssue({ code: "custom", path: ["DEV_LOGIN"], message: "Only for NODE_ENV=development" });
    }
  });

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * The public URL: APP_URL, or else CSRF_TRUSTED_ORIGINS of the Django version,
 * whose compose.yaml passes no APP_URL (and the new one passes that list as
 * APP_URL while APP_URL is unset). Django allows origins with a wildcard
 * (https://*.example.invalid), which name no address. Of the others, the
 * list must name exactly one: sign-in sends the provider back to it, and a
 * wrong guess would pass every health check while nobody can sign in.
 */
export function publicUrl(
  appUrl: string | undefined,
  trustedOrigins: string | undefined,
): { url?: string; problem?: string } {
  const listed = splitList(appUrl ?? "");
  const origins = listed.length > 0 ? listed : splitList(trustedOrigins ?? "");
  if (origins.length === 0) return {};
  const addresses = origins.filter((origin) => !origin.includes("*"));
  if (addresses.length === 1) return { url: addresses[0] };
  const source = listed.length > 0 ? "APP_URL" : "CSRF_TRUSTED_ORIGINS (Django version)";
  return {
    problem:
      addresses.length === 0
        ? `${source} names only origins with a wildcard. Set APP_URL to the public URL, e.g. https://iam.example.invalid`
        : `${source} names several addresses. Set APP_URL to the public URL of IAM`,
  };
}

function splitList(value: string, lower = false): string[] {
  return value
    .split(",")
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

type Parsed = z.infer<typeof schema>;

export type Config = Omit<Parsed, "APP_URL" | "AUTH_SECRET" | "ENCRYPTION_KEY" | "HOST"> & {
  APP_URL: string;
  HOST: string;
  AUTH_SECRET: string;
  /** The Fernet keys; empty only in development and tests (a derived key then). */
  encryptionKeys: string[];
  isDevelopment: boolean;
  /** The issuer of the sign-in provider without a trailing slash; empty: sign-in not set up. */
  oidcIssuer: string;
  /** The issuer as configured: ID tokens name it so when the provider has no discovery document. */
  oidcIssuerConfigured: string;
  oidcProviderKind: "keycloak" | "oidc";
  oidcProviderName: string;
  oidcEnabled: boolean;
  adminGroups: string[];
  approverGroups: string[];
  viewerGroups: string[];
  bootstrapAdminEmails: string[];
};

let cached: Config | undefined;

const DEV_SECRET = "development-secret-development-secret-development";

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const value = parsed.data;
  const problems: string[] = [];
  const isDevelopment = value.NODE_ENV !== "production";

  const named = publicUrl(value.APP_URL, value.CSRF_TRUSTED_ORIGINS);
  let appUrl = named.url ?? (isDevelopment && !named.problem ? `http://localhost:${value.PORT}` : "");
  appUrl = appUrl.replace(/\/+$/, "");
  // Scheme and host in lower case (HTTPS://… counts as https), no default
  // port, no slash at the end. The callback URL built from it must match the
  // redirect_uri openid-client sends at the code exchange, which it takes
  // from a parsed URL; the Django version built it from the browser's Host
  // header, which never names a default port either.
  if (appUrl && URL.canParse(appUrl)) appUrl = new URL(appUrl).href.replace(/\/+$/, "");
  if (named.problem) problems.push(`APP_URL: ${named.problem}`);
  else if (!appUrl) problems.push("APP_URL: Set the public URL, e.g. https://iam.example.invalid");
  else if (!z.url({ protocol: /^https?$/ }).safeParse(appUrl).success) {
    problems.push("APP_URL: Must be an http:// or https:// URL");
  } else if (value.NODE_ENV === "production" && !/^https:/i.test(appUrl) && !isLocal(appUrl)) {
    // Sessions travel in cookies that only HTTPS keeps secret.
    problems.push("APP_URL: Must be an https:// URL in production (http only for localhost)");
  }

  const secret = value.AUTH_SECRET ?? value.DJANGO_SECRET_KEY ?? (isDevelopment ? DEV_SECRET : "");
  const deployed = value.NODE_ENV === "production" || /^https:/i.test(appUrl);
  if (!secret) problems.push("AUTH_SECRET: Set a random secret of at least 32 characters");
  else if (secret.length < 32) problems.push("AUTH_SECRET: Must have at least 32 characters");
  else if (deployed && EXAMPLE_SECRETS.has(secret)) {
    problems.push("AUTH_SECRET: Replace the example value (openssl rand -base64 48)");
  }

  const encryptionKeys = splitList(value.ENCRYPTION_KEY ?? "");
  if (encryptionKeys.length === 0 && !isDevelopment) {
    problems.push(
      "ENCRYPTION_KEY: Set a Fernet key to encrypt connection secrets (npm run cli generate-key)",
    );
  }
  for (const key of encryptionKeys) {
    if (Buffer.from(key, "base64url").length !== 32 || !/^[A-Za-z0-9_-]{43}=?$/.test(key)) {
      problems.push("ENCRYPTION_KEY: Must be Fernet keys: 32 url-safe base64-encoded bytes each");
      break;
    }
  }

  const keycloakUrl = (value.KEYCLOAK_URL ?? "").replace(/\/+$/, "");
  const fromKeycloak = Boolean(keycloakUrl && value.KEYCLOAK_REALM);
  const oidcIssuer = fromKeycloak
    ? `${keycloakUrl}/realms/${value.KEYCLOAK_REALM}`
    : (value.OIDC_ISSUER ?? "").replace(/\/+$/, "");
  const oidcProviderKind = fromKeycloak || oidcIssuer.includes("/realms/") ? "keycloak" : "oidc";
  if (problems.length > 0) throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);

  cached = {
    ...value,
    APP_URL: appUrl,
    HOST: value.HOST ?? (isDevelopment ? "127.0.0.1" : "0.0.0.0"),
    AUTH_SECRET: secret,
    encryptionKeys,
    isDevelopment,
    oidcIssuer,
    oidcIssuerConfigured: fromKeycloak ? oidcIssuer : (value.OIDC_ISSUER ?? "").trim(),
    oidcProviderKind,
    oidcProviderName:
      value.OIDC_PROVIDER_NAME ?? (oidcProviderKind === "keycloak" ? "Keycloak" : "single sign-on"),
    oidcEnabled: Boolean(oidcIssuer && value.OIDC_CLIENT_ID),
    adminGroups: splitList(value.OIDC_ADMIN_GROUPS),
    approverGroups: splitList(value.OIDC_APPROVER_GROUPS),
    viewerGroups: splitList(value.OIDC_VIEWER_GROUPS),
    bootstrapAdminEmails: splitList(value.BOOTSTRAP_ADMIN_EMAILS, true),
  };
  return cached;
}

/** Tests only: forget the cached configuration after changing process.env. */
export function resetConfigForTests() {
  cached = undefined;
}

/** Tests only: change settings of the cached configuration for one test. */
export function overrideConfigForTests(values: Partial<Config>) {
  Object.assign(config(), values);
}
