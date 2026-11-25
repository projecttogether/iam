import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { now } from "../core/time";
import {
  Adapter,
  AdapterError,
  ConfigurationError,
  SYNC_INTERVAL_FIELD,
  TransientError,
  displayName,
  ensureResult,
  externalAccount,
  externalGroup,
  field,
  generatePassword,
  type AccountPlan,
  type AccountSpec,
  type EnsureResult,
  type ExternalAccount,
  type ExternalGroup,
  type JobActionName,
  type TestResult,
} from "./base";
import {
  HttpTimeoutError,
  HttpTransportError,
  timing,
  type HttpClient,
  type HttpResponse,
  type RequestOptions,
} from "./http";

/**
 * Google Workspace accounts and Google Groups through the Admin SDK
 * Directory API, as a service account. The service account either holds
 * Google Workspace admin roles itself or acts as an admin user (domain-wide
 * delegation).
 */

/** 403 reasons of quotas and rate limits: the request may run again later. */
const RATE_LIMIT_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded", "quotaExceeded"]);
const API_BASE = "https://admin.googleapis.com";
const DIRECTORY = "/admin/directory/v1";
export const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.group.member",
];
/** Where a key without `token_uri` signs in; Google's keys name this one. */
export const TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** How long the signed assertion is valid, in seconds (as google-auth). */
const ASSERTION_LIFETIME_SECONDS = 3600;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Percent-encodes like Python's urllib.parse.quote: letters, digits, `_.-~`
 * and the characters in `safe` stay as they are.
 */
function quote(value: string, safe = ""): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%([0-9A-F]{2})/g, (code, hex: string) => {
      const byte = Number.parseInt(hex, 16);
      const char = String.fromCharCode(byte);
      return byte < 0x80 && safe.includes(char) ? char : code;
    });
}

/** The reasons of a Google API error answer; never shown to anyone. */
function errorReasons(response: HttpResponse): Set<string> {
  try {
    const error = asRecord(response.json()).error;
    if (!isRecord(error) || !Array.isArray(error.errors)) return new Set();
    return new Set(error.errors.filter(isRecord).map((entry) => String(entry.reason)));
  } catch {
    return new Set();
  }
}

/** Missing flags mean unknown privileges, not a normal user. */
function lacksAdminPrivileges(user: Json): boolean {
  return ["isAdmin", "isDelegatedAdmin"].every((flag) => user[flag] === false);
}

/** Why the app does not reactivate or suspend this user, if it does not. */
function refusal(user: Json, active: boolean): string {
  if (active && !lacksAdminPrivileges(user)) {
    return (
      "Suspended Google Workspace administrator accounts are not reactivated " +
      "automatically. Reactivate the account in the Google Admin console."
    );
  }
  if (!active && user.isAdmin === true) {
    return "Google Workspace super admins are not suspended automatically.";
  }
  return "";
}

function aliasRefusal(email: string): string {
  return (
    `${email} is an alias of another Google Workspace user. Nothing was changed. Remove ` +
    "the alias in the Google Admin console or use another work email."
  );
}

function toAccount(user: Json): ExternalAccount {
  const email = textOf(user.primaryEmail);
  const name = asRecord(user.name);
  return externalAccount(String(user.id ?? ""), {
    username: email,
    email,
    displayName: textOf(name.fullName),
    active: user.suspended !== true,
  });
}

/** What the app signs in with, read from the service account's JSON key. */
type ServiceAccountKey = {
  clientEmail: string;
  privateKey: KeyObject;
  keyId: string;
  tokenUri: string;
};

const INVALID_KEY = "The service account key is not a valid Google service account JSON key.";

/**
 * The key's parts, or a ConfigurationError. Errors carry no cause: a JSON
 * parse error quotes the text it read, which is the secret key.
 */
function serviceAccountKey(raw: unknown): ServiceAccountKey {
  let info: unknown;
  try {
    info = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new ConfigurationError(INVALID_KEY);
  }
  if (!isRecord(info) || typeof info.client_email !== "string" || !info.client_email) {
    throw new ConfigurationError(INVALID_KEY);
  }
  if (typeof info.private_key !== "string") throw new ConfigurationError(INVALID_KEY);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(info.private_key);
  } catch {
    throw new ConfigurationError(INVALID_KEY);
  }
  if (privateKey.asymmetricKeyType !== "rsa") throw new ConfigurationError(INVALID_KEY);
  const tokenUri = info.token_uri === undefined ? TOKEN_URI : info.token_uri;
  if (typeof tokenUri !== "string" || !/^https?:\/\//i.test(tokenUri) || !URL.canParse(tokenUri)) {
    throw new ConfigurationError(INVALID_KEY);
  }
  return { clientEmail: info.client_email, privateKey, keyId: textOf(info.private_key_id), tokenUri };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** OAuth errors google-auth retries: the token endpoint was busy, not the key wrong. */
const TEMPORARY_OAUTH_ERRORS = new Set(["temporarily_unavailable", "server_error", "internal_failure"]);

/** Statuses google-auth retries (DEFAULT_RETRYABLE_STATUS_CODES). */
const RETRY_STATUSES = new Set([408, 429, 500, 503, 504]);

/** Tries of the token exchange while Google's token endpoint is busy. */
const TOKEN_TRIES = 3;

/**
 * Whether google-auth would try the token exchange again: a status it
 * retries, or one of the temporary OAuth errors as the whole `error` or
 * `error_description`.
 */
function tokenRequestIsRetried(response: HttpResponse): boolean {
  if (response.status === 200) return false;
  if (RETRY_STATUSES.has(response.status)) return true;
  try {
    const body = asRecord(response.json());
    return [body.error, body.error_description].some(
      (value) => typeof value === "string" && TEMPORARY_OAUTH_ERRORS.has(value),
    );
  } catch {
    return false;
  }
}

/**
 * The OAuth 2.0 assertion (RFC 7523) that google-auth signs for a service
 * account: an RS256 JWT for the scopes, valid for an hour, on behalf of
 * `subject` (domain-wide delegation) when one is given.
 */
function signAssertion(key: ServiceAccountKey, subject: string): string {
  const header: Json = { typ: "JWT", alg: "RS256" };
  if (key.keyId) header.kid = key.keyId;
  const issuedAt = Math.floor(now().getTime() / 1000);
  const claims: Json = {
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    // The issuer must be the service account email.
    iss: key.clientEmail,
    // google-auth signs for Google's token endpoint, wherever the key's
    // token_uri sends the assertion.
    aud: TOKEN_URI,
    scope: SCOPES.join(" "),
  };
  // The subject can be a user email for domain-wide delegation.
  if (subject) claims.sub = subject;
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(key.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

export class GoogleWorkspaceAdapter extends Adapter {
  static override readonly slug = "google_workspace";
  static override readonly label = "Google Workspace";
  static override readonly description =
    "Creates, suspends and reactivates Google Workspace users and manages their " +
    "Google Groups memberships.";
  static override readonly supportsGroups = true;
  static override readonly groupLabel = "Google Groups";
  static override readonly fields = [
    field("service_account_json", "Service account key (JSON)", {
      kind: "secret",
      required: true,
      help:
        "The JSON key of a service account that holds the admin roles User " +
        "Management Admin and Groups Admin, or that has domain-wide delegation " +
        "for the scopes admin.directory.user, admin.directory.group and " +
        "admin.directory.group.member.",
    }),
    field("admin_email", "Admin user", {
      kind: "email",
      help:
        "Only for domain-wide delegation: the Google Workspace admin the service " +
        "account acts as. Leave empty when the service account holds admin roles " +
        "itself.",
      placeholder: "admin@example.invalid",
    }),
    field("domain", "Domains", {
      required: true,
      help:
        "Work emails of new users must be in one of these domains, separated by " +
        "commas. The first one is the primary domain. Accounts in all domains " +
        "are read.",
      placeholder: "example.invalid, extern.example.invalid",
    }),
    field("customer_id", "Customer ID", {
      default: "my_customer",
      help:
        "Leave as my_customer: without an admin user, the app looks up the ID in " +
        "the primary domain. Change only if the admin user manages several " +
        "accounts.",
    }),
    field("org_unit_path", "Organizational unit for new users", { default: "/", placeholder: "/Staff" }),
    field("deliver_initial_password", "Email a first password", {
      kind: "bool",
      default: true,
      help:
        "New users get a generated password that must be changed at first sign-in. " +
        "The app emails it to the person's personal address through the email " +
        "connection and never stores it.",
    }),
    SYNC_INTERVAL_FIELD,
  ];

  private cachedClient: HttpClient | null = null;
  private resolvedCustomer: string | null = null;
  /** The user findAccount read last, so a plan need not read it again. */
  private lastUser: Json | null = null;

  // -- connection --------------------------------------------------------------

  /** The configured domains, the primary one first. */
  get domains(): string[] {
    const found: string[] = [];
    for (const part of String(this.setting("domain", "")).split(/[\s,;]+/)) {
      const domain = part.trim().replace(/^@+/, "").toLowerCase();
      if (domain && !found.includes(domain)) found.push(domain);
    }
    return found;
  }

  /** The primary domain. */
  get domain(): string {
    return this.domains[0] ?? "";
  }

  async customer(): Promise<string> {
    const configured = String(this.setting("customer_id", "")).trim();
    if (configured && configured !== "my_customer") return configured;
    if (this.setting("admin_email")) return "my_customer";
    return this.customerOfDomain();
  }

  /**
   * The customer ID, read from a user of the primary domain. A service
   * account that acts as itself is no Workspace user, so Google cannot
   * resolve my_customer for it.
   */
  private async customerOfDomain(): Promise<string> {
    if (this.resolvedCustomer === null) {
      const response = await this.request("GET", "/users", "look up the customer ID", {
        params: { domain: this.domain, maxResults: 1, fields: "users(customerId)" },
      });
      const users = asRecord(response.json()).users;
      const first: unknown = Array.isArray(users) ? users[0] : undefined;
      const customer = isRecord(first) ? first.customerId : undefined;
      if (typeof customer !== "string" || !customer.trim()) {
        throw new ConfigurationError(
          `Google Workspace returned no user in ${this.domain}, so the customer ID ` +
            "is unknown. Check the domains, or enter the customer ID from the Google " +
            "Admin console (Account > Account settings).",
        );
      }
      this.resolvedCustomer = customer.trim();
    }
    return this.resolvedCustomer;
  }

  /**
   * Signs in the service account (the JWT bearer grant google-auth uses) and
   * returns the access token. Tests replace it.
   */
  protected async accessToken(): Promise<string> {
    this.require("service_account_json", "domain");
    const key = serviceAccountKey(this.setting("service_account_json"));
    let assertion: string;
    try {
      assertion = signAssertion(key, String(this.setting("admin_email", "")));
    } catch (error) {
      throw new ConfigurationError("Google could not sign in the service account.", { cause: error });
    }
    // As google-auth: a busy token endpoint gets three tries, a short pause between them.
    let response: HttpResponse;
    for (let attempt = 1; ; attempt += 1) {
      try {
        response = await this.http().request("POST", key.tokenUri, {
          form: { grant_type: JWT_GRANT_TYPE, assertion },
        });
      } catch (error) {
        if (error instanceof HttpTimeoutError || error instanceof HttpTransportError) {
          throw new TransientError("Could not reach Google to sign in the service account.", {
            cause: error,
          });
        }
        throw error;
      }
      if (!tokenRequestIsRetried(response) || attempt >= TOKEN_TRIES) break;
      await timing.pause(attempt);
    }
    // A busy or failing token endpoint is no reason to check the key (google-auth
    // raised a RefreshError either way; the Django version called it refused).
    if (tokenRequestIsRetried(response) || response.status >= 500) {
      throw new TransientError("Could not reach Google to sign in the service account.");
    }
    let token: unknown;
    if (response.status === 200) {
      try {
        token = asRecord(response.json()).access_token;
      } catch {
        token = undefined;
      }
    }
    if (typeof token === "string" && token) return token;
    if (this.setting("admin_email")) {
      throw new ConfigurationError(
        "Google refused the service account. Check domain-wide delegation for " +
          "its client ID, the scopes admin.directory.user, admin.directory.group " +
          "and admin.directory.group.member, and that the admin user is an " +
          "administrator.",
      );
    }
    throw new ConfigurationError(
      "Google refused the service account. Check that its key is valid and not deleted.",
    );
  }

  private async client(): Promise<HttpClient> {
    if (this.cachedClient === null) {
      const token = await this.accessToken();
      this.cachedClient = this.http(API_BASE, { headers: { Authorization: `Bearer ${token}` } });
    }
    return this.cachedClient;
  }

  override raiseForStatus(response: HttpResponse, what: string): void {
    if (
      response.status === 403 &&
      [...errorReasons(response)].some((reason) => RATE_LIMIT_REASONS.has(reason))
    ) {
      throw new TransientError(
        `Google Workspace limited the request rate while trying to ${what}; ` + "it runs again later.",
      );
    }
    if ((response.status === 401 || response.status === 403) && !this.setting("admin_email")) {
      throw new ConfigurationError(
        `Google Workspace refused access (${response.status}) while trying to ` +
          `${what}. Check that the service account holds the admin roles User ` +
          "Management Admin and Groups Admin in the Google Admin console.",
      );
    }
    super.raiseForStatus(response, what);
  }

  /** A Directory API call. Status codes in `allow` are returned, not thrown. */
  private async request(
    method: string,
    path: string,
    what: string,
    options: RequestOptions & { allow?: number[] } = {},
  ): Promise<HttpResponse> {
    const { allow = [], ...rest } = options;
    const response = await this.send(await this.client(), method, DIRECTORY + path, what, rest);
    if (allow.includes(response.status)) return response;
    this.raiseForStatus(response, what);
    return response;
  }

  private async pages(
    path: string,
    key: string,
    what: string,
    params: Record<string, string | number>,
  ): Promise<Json[]> {
    const query = { ...params };
    const items: Json[] = [];
    for (;;) {
      const data = asRecord((await this.request("GET", path, what, { params: query })).json());
      const page = data[key];
      if (Array.isArray(page)) items.push(...page.filter(isRecord));
      const token = data.nextPageToken;
      if (!token) return items;
      query.pageToken = String(token);
    }
  }

  override handsOutSignIn(): boolean {
    return Boolean(this.setting("deliver_initial_password", true));
  }

  override async testConnection(): Promise<TestResult> {
    const customer = await this.customer();
    await this.request("GET", "/users", "list users", { params: { customer, maxResults: 1 } });
    return { ok: true, message: `Connected to Google Workspace for ${this.domains.join(", ")}.` };
  }

  // -- groups ------------------------------------------------------------------

  override async listGroups(): Promise<ExternalGroup[]> {
    const groups = await this.pages("/groups", "groups", "list groups", {
      customer: await this.customer(),
      maxResults: 200,
    });
    return groups.map((group) =>
      externalGroup(String(group.id), textOf(group.name) || textOf(group.email), {
        path: textOf(group.email),
        description: textOf(group.description),
      }),
    );
  }

  override async accountGroups(account: ExternalAccount): Promise<Set<string>> {
    const groups = await this.pages("/groups", "groups", "list the user's groups", {
      userKey: account.externalId,
      maxResults: 200,
    });
    return new Set(groups.map((group) => String(group.id)));
  }

  override async addToGroup(account: ExternalAccount, groupId: string): Promise<void> {
    await this.request("POST", `/groups/${quote(groupId)}/members`, "add a group member", {
      allow: [409],
      json: { email: account.email, role: "MEMBER" },
    });
  }

  override async removeFromGroup(account: ExternalAccount, groupId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/groups/${quote(groupId)}/members/${quote(account.externalId)}`,
      "remove a group member",
      { allow: [404] },
    );
  }

  // -- accounts ----------------------------------------------------------------

  private async getUser(key: string): Promise<Json | null> {
    const response = await this.request("GET", `/users/${quote(key, "@")}`, "read a user", { allow: [404] });
    return response.status === 404 ? null : asRecord(response.json());
  }

  private workEmail(spec: AccountSpec): string {
    const email = (spec.email || "").trim().toLowerCase();
    if (!email) throw new AdapterError("Google Workspace accounts need a work email.");
    if (!this.domains.includes(email.slice(email.lastIndexOf("@") + 1))) {
      if (this.domains.length === 1) {
        throw new AdapterError(`The work email must be in the domain ${this.domain}.`);
      }
      throw new AdapterError(`The work email must be in one of the domains ${this.domains.join(", ")}.`);
    }
    return email;
  }

  /**
   * The user whose primary address this is. Google also answers for an
   * alias, with the user that owns it: someone else's account.
   */
  private async getUserByEmail(email: string): Promise<Json | null> {
    const user = await this.getUser(email);
    if (
      user === null ||
      String(user.primaryEmail ?? "")
        .trim()
        .toLowerCase() !== email
    )
      return null;
    return user;
  }

  private async aliasOwner(email: string): Promise<boolean> {
    const user = await this.getUser(email);
    return (
      user !== null &&
      String(user.primaryEmail ?? "")
        .trim()
        .toLowerCase() !== email
    );
  }

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    let user = externalId ? await this.getUser(externalId) : null;
    if (user === null && spec.email) user = await this.getUserByEmail(spec.email.trim().toLowerCase());
    if (user === null) return null;
    this.lastUser = user;
    return toAccount(user);
  }

  override async createAccount(spec: AccountSpec): Promise<EnsureResult> {
    const email = this.workEmail(spec);
    const body: Json = {
      primaryEmail: email,
      name: { givenName: spec.firstName, familyName: spec.lastName },
      changePasswordAtNextLogin: true,
      orgUnitPath: this.setting("org_unit_path", "/"),
    };
    if (spec.personalEmail) body.recoveryEmail = spec.personalEmail;
    const deliver = Boolean(this.setting("deliver_initial_password", true));
    // Google requires a password; an undelivered one is random and unknown.
    const password = deliver ? generatePassword() : generatePassword(40);
    body.password = password;
    let response: HttpResponse;
    try {
      response = await this.request("POST", "/users", "create a user", { allow: [409], json: body });
    } catch (error) {
      if (!(error instanceof TransientError)) throw error;
      // The answer was lost, but Google may have created the user with
      // this password: a retry would find it and never send one.
      const created = await this.findAccount(spec);
      if (created === null) throw error;
      return ensureResult(created, {
        created: true,
        initialPassword: deliver ? password : null,
        notes: ["Created the Google Workspace user; Google's answer was lost."],
      });
    }
    if (response.status === 409) {
      const existing = await this.findAccount(spec);
      if (existing === null && (await this.aliasOwner(email))) throw new AdapterError(aliasRefusal(email));
      if (existing === null) {
        throw new TransientError("Google reported the user as existing but did not return it.");
      }
      const result = ensureResult(existing);
      result.notes.push("The account already existed; no new password was set.");
      if (!existing.active) {
        result.account = await this.setActive(existing, true);
        result.reactivated = true;
      }
      return result;
    }
    const account = toAccount(asRecord(response.json()));
    account.groups = new Set();
    return ensureResult(account, {
      created: true,
      initialPassword: deliver ? password : null,
      notes: ["Created the Google Workspace user."],
    });
  }

  override async planEnsure(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planEnsure(spec, account);
    if (plan.change === "create") {
      let email: string;
      try {
        email = this.workEmail(spec);
      } catch (error) {
        if (!(error instanceof AdapterError)) throw error;
        plan.refusal = error.message;
        return plan;
      }
      if (await this.aliasOwner(email)) plan.refusal = aliasRefusal(email);
    } else if (plan.change === "reactivate" && account !== null) {
      plan.refusal = refusal(await this.userOf(account), true);
    }
    return plan;
  }

  override async planDisable(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planDisable(spec, account);
    if (plan.change === "disable" && account !== null) {
      plan.refusal = refusal(await this.userOf(account), false);
    }
    return plan;
  }

  private async userOf(account: ExternalAccount): Promise<Json> {
    const user = this.lastUser;
    if (user === null || String(user.id) !== account.externalId) {
      return (await this.getUser(account.externalId)) ?? {};
    }
    return user;
  }

  override async setActive(account: ExternalAccount, active: boolean): Promise<ExternalAccount> {
    const refused = refusal(await this.userOf(account), active);
    if (refused) throw new AdapterError(refused);
    const response = await this.request(
      "PUT",
      `/users/${quote(account.externalId)}`,
      "suspend or reactivate a user",
      { json: { suspended: !active } },
    );
    const updated = toAccount(asRecord(response.json()));
    updated.groups = account.groups;
    return updated;
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    const users = await this.pages("/users", "users", "list users", {
      customer: await this.customer(),
      maxResults: 500,
    });
    return users.map(toAccount);
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    if (action === "disable_account") {
      return (
        `In the Google Admin console, suspend the user ${who} and remove them from ` +
        "the Google Groups this app manages."
      );
    }
    const lines = [`In the Google Admin console, make sure ${who} is an active user.`];
    if (groups.length > 0) lines.push(`Google Groups: ${groups.join(", ")}.`);
    return lines.join("\n");
  }
}
