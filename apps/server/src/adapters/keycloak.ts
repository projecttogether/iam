/**
 * Keycloak: users and groups in one realm, through the Admin REST API.
 *
 * The connection signs in as a confidential client with a service account
 * (client credentials grant). Give that service account these roles of the
 * realm's `realm-management` client: view-users, query-users, manage-users,
 * query-groups and view-realm. Since Keycloak 26.8.2 the client also needs the
 * default client scope kc-admin-api: the Admin REST API refuses tokens without
 * the audience it adds.
 */

import { config } from "../config";
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
  type DisableResult,
  type EnsureResult,
  type ExternalAccount,
  type ExternalGroup,
  type JobActionName,
  type TestResult,
} from "./base";
import type { HttpClient, HttpResponse, RequestOptions } from "./http";

const PAGE_SIZE = 100;
const REQUIRED_ROLES = "view-users, query-users, manage-users, query-groups and view-realm";
const ADMIN_SCOPE = "kc-admin-api";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** A JSON object as Keycloak sends it. */
type Json = Record<string, unknown>;
type Params = NonNullable<RequestOptions["params"]>;
type Names = { firstName: string; lastName: string };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truth test for a JSON value: null, false, 0, "" and empty lists and objects are false. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** A JSON value as text; empty for one that is false (Python's `str(value or "")`). */
function str(value: unknown): string {
  return truthy(value) ? String(value) : "";
}

/** Python's `quote(value, safe="")`: every character but letters, digits and _.-~ percent-encoded. */
function quote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A string in quotes as Python's repr() writes it. */
function pythonRepr(value: string): string {
  const mark = value.includes("'") && !value.includes('"') ? '"' : "'";
  let inner = "";
  for (const char of value) {
    if (char === mark || char === "\\") inner += `\\${char}`;
    else if (char === "\n") inner += "\\n";
    else if (char === "\r") inner += "\\r";
    else if (char === "\t") inner += "\\t";
    else if (char < " " || char === "\x7f") inner += `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else inner += char;
  }
  return `${mark}${inner}${mark}`;
}

/** Python's `float(value)` for the token's lifetime; null for a value that is no number. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value))
    return Number(value);
  return null;
}

/** Seconds of a clock that never goes back (Python's time.monotonic). */
function monotonic(): number {
  return performance.now() / 1000;
}

/**
 * One URL path segment for a user or group ID. "." and ".." would be
 * resolved as relative steps out of the users path, so they are refused.
 */
function pathSegment(value: string): string {
  const text = value || "";
  if (text === "" || text === "." || text === "..") {
    throw new AdapterError("Keycloak returned an identifier that is not a valid path segment.");
  }
  return quote(text);
}

export class KeycloakAdapter extends Adapter {
  static override readonly slug = "keycloak";
  static override readonly label = "Keycloak";
  static override readonly description =
    "Creates, enables and disables users in a Keycloak realm and manages their group " +
    "memberships. Signs in as a confidential client with a service account.";
  static override readonly supportsGroups = true;
  static override readonly groupLabel = "Groups";
  static override readonly fields = [
    field("base_url", "Keycloak URL", {
      kind: "url",
      required: true,
      destination: true,
      placeholder: "https://sso.example.invalid",
      help: "Without /realms/... Include /auth only for Keycloak versions before 17.",
    }),
    field("allow_http", "Allow plain HTTP", {
      kind: "bool",
      default: false,
      destination: true,
      help:
        "Only for a Keycloak in the same private network, e.g. http://keycloak:8080 " +
        "inside one Docker network. Everything else must use HTTPS.",
    }),
    field("realm", "Realm", { required: true, placeholder: "example" }),
    field("client_id", "Client ID", {
      required: true,
      help:
        "A confidential client with service accounts on and, since Keycloak 26.8.2, " +
        `the default client scope ${ADMIN_SCOPE}. Its service account needs the ` +
        `realm-management roles ${REQUIRED_ROLES}.`,
    }),
    field("client_secret", "Client secret", { kind: "secret", required: true }),
    field("group_root", "Group root", {
      placeholder: "/apps",
      help: "Import only the groups below this group path. Empty imports every group.",
    }),
    field("username_source", "Username", {
      kind: "choice",
      default: "username",
      choices: [
        ["username", "Login name (the work email before @)"],
        ["email", "Full work email"],
      ],
    }),
    field("send_setup_email", "Send setup email", {
      kind: "bool",
      default: true,
      help:
        "After creating a user, Keycloak emails a link to set a password to the " +
        "user's email. Needs email settings in the realm.",
    }),
    field("setup_email_lifespan_hours", "Setup link valid for (hours)", { kind: "int", default: 72 }),
    field("set_temporary_password", "Set a temporary password", {
      kind: "bool",
      default: false,
      help:
        "Instead of the setup email: set a temporary password, which the app sends " +
        "to the person's private email through the email connection. Keycloak asks " +
        "for a new password at the first sign-in.",
    }),
    field("logout_on_disable", "End sessions on disable", {
      kind: "bool",
      default: true,
      help: "Sign the user out of every session when the account is disabled.",
    }),
    SYNC_INTERVAL_FIELD,
  ];

  private clientInstance: HttpClient | null = null;
  private token = "";
  private tokenExpiresAt = 0;
  /** Full user representations from the last reads, by user ID. */
  private readonly users = new Map<string, Json>();

  // -- configuration -----------------------------------------------------------

  get baseUrl(): string {
    return String(this.setting("base_url", "")).replace(/\/+$/, "");
  }

  get realm(): string {
    return String(this.setting("realm", "")).trim();
  }

  private checkConfig(): void {
    this.require("base_url", "realm", "client_id", "client_secret");
    let parts: URL | null;
    try {
      parts = new URL(this.baseUrl);
    } catch {
      parts = null;
    }
    const scheme = parts ? parts.protocol.replace(/:$/, "") : "";
    // URL keeps the brackets of an IPv6 host; urlsplit's hostname has none.
    const hostname = parts ? parts.hostname.replace(/^\[(.*)\]$/, "$1") : "";
    if (parts === null || (scheme !== "http" && scheme !== "https") || !hostname) {
      throw new ConfigurationError("The Keycloak URL must start with https://.");
    }
    if (
      scheme !== "https" &&
      !(config().isDevelopment || LOOPBACK_HOSTS.has(hostname) || this.setting("allow_http"))
    ) {
      throw new ConfigurationError(
        "The Keycloak URL must use HTTPS: the client secret and user data travel " + "over this connection.",
      );
    }
    if (parts.search || parts.hash) {
      throw new ConfigurationError("The Keycloak URL must not contain ? or #.");
    }
  }

  private client(): HttpClient {
    if (this.clientInstance === null) {
      this.checkConfig();
      this.clientInstance = this.http(`${this.baseUrl}/`);
    }
    return this.clientInstance;
  }

  private adminPath(path = ""): string {
    const root = `admin/realms/${pathSegment(this.realm)}`;
    return path ? `${root}/${path}` : root;
  }

  private userPath(userId: string, suffix = ""): string {
    const path = this.adminPath(`users/${pathSegment(userId)}`);
    return suffix ? `${path}/${suffix}` : path;
  }

  // -- HTTP ----------------------------------------------------------------------

  /** A request whose transport failures become adapter errors; the caller checks the status. */
  private async transmit(
    method: string,
    path: string,
    what: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    return this.send(this.client(), method, path, what, options);
  }

  private async accessToken(): Promise<string> {
    if (this.token && monotonic() < this.tokenExpiresAt) return this.token;
    const what = "sign in with the client credentials";
    const response = await this.transmit(
      "POST",
      `realms/${pathSegment(this.realm)}/protocol/openid-connect/token`,
      what,
      {
        form: {
          grant_type: "client_credentials",
          client_id: String(this.setting("client_id", "")),
          client_secret: String(this.setting("client_secret", "")),
        },
      },
    );
    if (response.status === 400 || response.status === 401) {
      // A wrong secret answers 401; a client without service accounts 400.
      throw new ConfigurationError(
        `Keycloak refused the client ID and secret (${response.status}). Check ` +
          "the secret and that the client has client authentication and service " +
          "accounts turned on.",
      );
    }
    if (response.status === 404) {
      throw new ConfigurationError(
        `Keycloak has no realm ${pythonRepr(this.realm)} at this URL (404). Check the URL and realm.`,
      );
    }
    this.raiseForStatus(response, what);
    const data = this.readJson(response, what);
    const token = isObject(data) ? data.access_token : null;
    if (!truthy(token)) throw new AdapterError("Keycloak's token answer contained no access token.");
    const expiresIn = (isObject(data) ? toNumber(data.expires_in) : null) ?? 60;
    this.token = String(token);
    // Refresh before the token ends: one adapter can make many calls.
    this.tokenExpiresAt = monotonic() + Math.max(expiresIn - 30, 10);
    return this.token;
  }

  /** An Admin REST API call with the access token; null for 404 when `missingOk`. */
  private request(
    method: string,
    path: string,
    what: string,
    options: RequestOptions & { missingOk: true },
  ): Promise<HttpResponse | null>;
  private request(
    method: string,
    path: string,
    what: string,
    options?: RequestOptions,
  ): Promise<HttpResponse>;
  private async request(
    method: string,
    path: string,
    what: string,
    options: RequestOptions & { missingOk?: boolean } = {},
  ): Promise<HttpResponse | null> {
    const { missingOk = false, ...rest } = options;
    let retried = false;
    let response: HttpResponse;
    for (;;) {
      const fresh = !this.token || monotonic() >= this.tokenExpiresAt;
      const headers = { Authorization: `Bearer ${await this.accessToken()}` };
      response = await this.transmit(method, path, what, { ...rest, headers });
      if (response.status === 401 && !fresh && !retried) {
        // The cached token was revoked or expired early: sign in again once.
        this.token = "";
        retried = true;
        continue;
      }
      break;
    }
    if (response.status === 404 && missingOk) return null;
    if (response.status === 401) {
      // Keycloak issued the token but the Admin REST API refuses it.
      throw new ConfigurationError(
        `Keycloak refused the access token (401) while trying to ${what}. Since ` +
          `Keycloak 26.8.2 the client needs the default client scope ${ADMIN_SCOPE}.`,
      );
    }
    if (response.status === 403) {
      throw new ConfigurationError(
        `Keycloak refused access (403) while trying to ${what}. Give the client's ` +
          `service account the realm-management roles ${REQUIRED_ROLES}.`,
      );
    }
    this.raiseForStatus(response, what);
    return response;
  }

  private readJson(response: HttpResponse, what: string): unknown {
    try {
      return response.json();
    } catch (error) {
      throw new AdapterError(`Keycloak sent an unreadable answer while trying to ${what}.`, { cause: error });
    }
  }

  private async getList(path: string, what: string, params: Params = {}): Promise<Json[]> {
    const response = await this.request("GET", path, what, { params });
    const data = this.readJson(response, what);
    if (!Array.isArray(data)) {
      throw new AdapterError(`Keycloak sent an unexpected answer while trying to ${what}.`);
    }
    return data.filter(isObject);
  }

  /** Every item of a paged listing, read page by page as the items are used. */
  private async *pages(path: string, what: string, params: Params = {}): AsyncGenerator<Json> {
    let first = 0;
    for (;;) {
      const page = await this.getList(path, what, { first, max: PAGE_SIZE, ...params });
      yield* page;
      if (page.length < PAGE_SIZE) return;
      first += PAGE_SIZE;
    }
  }

  // -- conversions -----------------------------------------------------------------

  private remember(user: Json): ExternalAccount {
    const userId = str(user.id);
    if (!userId) throw new AdapterError("Keycloak returned a user without an ID.");
    this.users.set(userId, user);
    return externalAccount(userId, {
      username: str(user.username),
      email: str(user.email),
      displayName: [user.firstName, user.lastName].filter(truthy).map(String).join(" "),
      active: truthy(user.enabled ?? false),
      groups: null,
    });
  }

  private usernameFor(spec: AccountSpec): string {
    if (this.setting("username_source") === "email" && spec.email) {
      return spec.email.trim().toLowerCase();
    }
    const username = (spec.username || (spec.email ? (spec.email.split("@")[0] ?? "") : ""))
      .trim()
      .toLowerCase();
    if (!username) throw new AdapterError("The person has neither a login name nor a work email.");
    return username;
  }

  // -- checks and catalog ------------------------------------------------------------

  override async testConnection(): Promise<TestResult> {
    let count: unknown;
    try {
      await this.accessToken();
      const response = await this.request("GET", this.adminPath("users/count"), "count users");
      count = this.readJson(response, "count users");
      await this.getList(this.adminPath("groups"), "list groups", { first: 0, max: 1 });
    } catch (error) {
      if (error instanceof AdapterError) return { ok: false, message: error.message };
      throw error;
    }
    return { ok: true, message: `Connected to realm ${this.realm}: ${String(count)} users.` };
  }

  override async listGroups(): Promise<ExternalGroup[]> {
    let root = String(this.setting("group_root", "")).trim().replace(/\/+$/, "");
    if (root && !root.startsWith("/")) root = `/${root}`;
    const seen = new Set<string>();
    let groups: ExternalGroup[] = [];
    for await (const top of this.pages(this.adminPath("groups"), "list groups", {
      briefRepresentation: "false",
    })) {
      for await (const group of this.walkGroup(top, "", seen)) groups.push(group);
    }
    if (root) groups = groups.filter((group) => group.path.startsWith(`${root}/`));
    return groups;
  }

  private async *walkGroup(
    group: Json,
    parentPath: string,
    seen: Set<string>,
  ): AsyncGenerator<ExternalGroup> {
    const groupId = str(group.id).trim();
    if (!groupId || seen.has(groupId)) return;
    seen.add(groupId);
    const name = str(group.name).trim();
    let path = str(group.path).trim();
    if (!path && name) path = `${parentPath}/${name}`;
    if (!path) return;
    const attributes = group.attributes;
    const description = isObject(attributes) ? attributes.description : null;
    yield externalGroup(groupId, name || path.slice(path.lastIndexOf("/") + 1), {
      path,
      description: Array.isArray(description) && description.length > 0 ? String(description[0]) : "",
    });
    const count = group.subGroupCount;
    const inline = group.subGroups;
    let children: AsyncIterable<Json> | Json[];
    if (typeof count === "number" && Number.isInteger(count)) {
      // Keycloak 23+ leaves subGroups empty in listings and counts them instead.
      if (count === 0) return;
      children = this.pages(
        this.adminPath(`groups/${pathSegment(groupId)}/children`),
        `list the subgroups of ${path}`,
        { briefRepresentation: "false" },
      );
    } else if (Array.isArray(inline)) {
      // Older versions return the whole tree in the listing.
      children = inline.filter(isObject);
    } else {
      children = [];
    }
    for await (const child of children) yield* this.walkGroup(child, path, seen);
  }

  // -- accounts ------------------------------------------------------------------------

  private async getUser(userId: string): Promise<Json | null> {
    const response = await this.request("GET", this.userPath(userId), "read a user", { missingOk: true });
    if (response === null) return null;
    const user = this.readJson(response, "read a user");
    if (!isObject(user) || str(user.id) !== userId) {
      throw new AdapterError("Keycloak sent an unexpected answer while trying to read a user.");
    }
    return user;
  }

  private async search(attribute: "username" | "email", value: string): Promise<Json | null> {
    const what = `search users by ${attribute}`;
    const users = await this.getList(this.adminPath("users"), what, {
      [attribute]: value,
      exact: "true",
      briefRepresentation: "false",
    });
    const matches = users.filter(
      (user) => str(user[attribute]).trim().toLowerCase() === value.trim().toLowerCase(),
    );
    if (matches.length > 1) throw new AdapterError(`Several Keycloak users have the ${attribute} ${value}.`);
    return matches[0] ?? null;
  }

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    if (externalId) {
      const user = await this.getUser(externalId);
      if (user !== null) return this.remember(user);
    }
    const username = this.usernameFor(spec);
    let user = await this.search("username", username);
    if (user !== null) {
      this.checkSameEmail(username, [user.email], spec);
    } else if (spec.email) {
      user = await this.search("email", spec.email);
    }
    return user !== null ? this.remember(user) : null;
  }

  override async createAccount(spec: AccountSpec): Promise<EnsureResult> {
    const username = this.usernameFor(spec);
    const payload: Json = {
      username,
      firstName: spec.firstName,
      lastName: spec.lastName,
      enabled: true,
      emailVerified: false,
    };
    if (spec.email) payload.email = spec.email.trim().toLowerCase();
    const response = await this.postUser(payload);
    if (response === null) return this.adoptExisting(spec, username);
    const location = (response.headers.get("Location") ?? "").replace(/\/+$/, "");
    const userId = location.split("/users/").pop() ?? "";
    let user = userId && !userId.includes("/") ? await this.getUser(userId) : null;
    if (user === null) user = await this.search("username", username);
    if (user === null) throw new TransientError("Keycloak created the user but does not list it yet.");
    // Groups stay unread: Keycloak may have added the realm's default groups.
    const result = ensureResult(this.remember(user), { created: true });
    await this.deliverCredentials(spec, result.account, result);
    return result;
  }

  /** Create a user; null when Keycloak already has one (409). */
  private async postUser(payload: Json): Promise<HttpResponse | null> {
    const what = "create a user";
    const headers = { Authorization: `Bearer ${await this.accessToken()}` };
    const response = await this.transmit("POST", this.adminPath("users"), what, { headers, json: payload });
    if (response.status === 409) return null;
    if (response.status === 401) {
      this.token = "";
      return this.request("POST", this.adminPath("users"), what, { json: payload });
    }
    if (response.status === 403) {
      throw new ConfigurationError(
        "Keycloak refused access (403) while trying to create a user. Give the " +
          `client's service account the realm-management roles ${REQUIRED_ROLES}.`,
      );
    }
    this.raiseForStatus(response, what);
    return response;
  }

  /**
   * A create conflicted, e.g. after a lost answer: link the user that
   * exists when it is plausibly the same person.
   */
  private async adoptExisting(spec: AccountSpec, username: string): Promise<EnsureResult> {
    let user = await this.search("username", username);
    if (user === null && spec.email) user = await this.search("email", spec.email);
    if (user === null) {
      throw new AdapterError(
        "Keycloak reports that the user exists but finds no user with this username or email.",
      );
    }
    this.checkSameEmail(username, [user.email], spec);
    const account = this.remember(user);
    const result = ensureResult(account, { notes: ["Keycloak already had this user."] });
    if (!account.active) {
      result.account = await this.setActive(account, true);
      result.reactivated = true;
    }
    return result;
  }

  override handsOutSignIn(): boolean {
    return Boolean(this.setting("send_setup_email") || this.setting("set_temporary_password"));
  }

  /**
   * Arrange the first sign-in. A failure never fails the job: the user
   * exists, and a retry would find it and not come back here. It becomes
   * `credentialsProblem`, which the engine hands to a person.
   */
  private async deliverCredentials(
    spec: AccountSpec,
    account: ExternalAccount,
    result: EnsureResult,
  ): Promise<void> {
    if (this.setting("send_setup_email") && spec.email) {
      // Python's int() raised for a value that is no number; such a value means the default here.
      const lifespan = Number(this.setting("setup_email_lifespan_hours", 72) || 72);
      const hours = Number.isNaN(lifespan) ? 72 : Math.trunc(lifespan);
      const status = await this.trySend(
        "PUT",
        this.userPath(account.externalId, "execute-actions-email"),
        "send the setup email",
        { params: { lifespan: Math.max(hours, 1) * 3600 }, json: ["UPDATE_PASSWORD"] },
      );
      if (status > 0 && status < 400) {
        result.notes.push(`Keycloak sent the setup email to ${spec.email}.`);
        return;
      }
      result.credentialsProblem =
        `Keycloak could not send the setup email (${status || "no answer"}). Check ` +
        "the realm's email settings, then send it from the Keycloak admin console: " +
        "Users > the user > Credentials > Credential reset.";
      result.notes.push(result.credentialsProblem);
      return;
    }
    if (this.setting("set_temporary_password")) {
      const password = generatePassword();
      const status = await this.trySend(
        "PUT",
        this.userPath(account.externalId, "reset-password"),
        "set a temporary password",
        { json: { type: "password", value: password, temporary: true } },
      );
      if (status > 0 && status < 400) {
        result.initialPassword = password;
        return;
      }
      result.credentialsProblem =
        `Keycloak did not set a temporary password (${status || "no answer"}), for ` +
        "example because of the realm's password policy. Set one in the Keycloak " +
        "admin console and give it to the person in a safe way.";
      result.notes.push(result.credentialsProblem);
    }
  }

  /** The status of a call whose failure is reported, not raised; 0 when Keycloak did not answer. */
  private async trySend(
    method: string,
    path: string,
    what: string,
    options: RequestOptions = {},
  ): Promise<number> {
    try {
      const headers = { Authorization: `Bearer ${await this.accessToken()}` };
      return (await this.transmit(method, path, what, { ...options, headers })).status;
    } catch (error) {
      if (error instanceof AdapterError) return 0;
      throw error;
    }
  }

  override async setActive(account: ExternalAccount, active: boolean): Promise<ExternalAccount> {
    const what = active ? "enable a user" : "disable a user";
    // Send the whole representation back: partial updates can drop
    // attributes under Keycloak's declarative user profile.
    const found = await this.getUser(account.externalId);
    if (found === null) throw new AdapterError("The Keycloak user no longer exists.");
    const { access: _access, ...user } = found;
    user.enabled = active;
    await this.request("PUT", this.userPath(account.externalId), what, { json: user });
    if (!active && this.endsSessions()) await this.logout(account.externalId);
    const updated = this.remember(user);
    updated.groups = account.groups;
    return updated;
  }

  private async logout(userId: string): Promise<void> {
    await this.request("POST", this.userPath(userId, "logout"), "end the user's sessions");
  }

  override async disableAccount(
    spec: AccountSpec,
    options: Parameters<Adapter["disableAccount"]>[1],
  ): Promise<DisableResult> {
    const result = await super.disableAccount(spec, options);
    if (result.account !== null && !result.changed && this.endsSessions()) {
      // The user was disabled already, maybe by an earlier run whose
      // logout failed: end the sessions again.
      await this.logout(result.account.externalId);
    }
    return result;
  }

  override async planEnsure(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planEnsure(spec, account);
    if (account !== null && this.namesToUpdate(account.externalId, spec) !== null) {
      plan.also.push("update the name");
    }
    return plan;
  }

  override async planDisable(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planDisable(spec, account);
    if (account !== null && this.endsSessions()) plan.also.push("end the user's sessions");
    return plan;
  }

  /** Whether disabling, or finding the user disabled already, ends its sessions. */
  private endsSessions(): boolean {
    return Boolean(this.setting("logout_on_disable"));
  }

  /** Keycloak puts a new user in the realm's default groups. */
  override async newAccountGroups(): Promise<Set<string>> {
    const groups = await this.getList(this.adminPath("default-groups"), "read the default groups");
    return new Set(groups.filter((group) => truthy(group.id)).map((group) => String(group.id)));
  }

  override async accountGroups(account: ExternalAccount): Promise<Set<string>> {
    if (account.groups !== null) return new Set(account.groups);
    const groups = new Set<string>();
    for await (const group of this.pages(
      this.userPath(account.externalId, "groups"),
      "read a user's groups",
      {
        briefRepresentation: "true",
      },
    )) {
      if (truthy(group.id)) groups.add(String(group.id));
    }
    account.groups = new Set(groups);
    return groups;
  }

  override async addToGroup(account: ExternalAccount, groupId: string): Promise<void> {
    await this.request(
      "PUT",
      this.userPath(account.externalId, `groups/${pathSegment(groupId)}`),
      `add a user to group ${groupId}`,
    );
  }

  override async removeFromGroup(account: ExternalAccount, groupId: string): Promise<void> {
    // 404: the group is gone, so the membership is too.
    await this.request(
      "DELETE",
      this.userPath(account.externalId, `groups/${pathSegment(groupId)}`),
      `remove a user from group ${groupId}`,
      { missingOk: true },
    );
  }

  override async ensureAccount(
    spec: AccountSpec,
    options: Parameters<Adapter["ensureAccount"]>[1],
  ): Promise<EnsureResult> {
    const result = await super.ensureAccount(spec, options);
    if (!result.created) await this.updateNames(spec, result);
    return result;
  }

  /**
   * Keep first and last name current. Username and email stay as they
   * are: changing them can hand a login to someone else, so that is a
   * decision for a Keycloak admin.
   */
  private async updateNames(spec: AccountSpec, result: EnsureResult): Promise<void> {
    const userId = result.account.externalId;
    const user = this.users.get(userId);
    if (user === undefined) return;
    const wanted = this.namesToUpdate(userId, spec);
    if (wanted !== null) {
      const found = await this.getUser(userId);
      if (found !== null) {
        const { access: _access, ...current } = found;
        Object.assign(current, wanted);
        await this.request("PUT", this.userPath(userId), "update a user's name", { json: current });
        result.notes.push("Updated the name in Keycloak.");
      }
    }
    if (spec.email && str(user.email).toLowerCase() !== spec.email.trim().toLowerCase()) {
      result.notes.push("The email in Keycloak differs from the work email; the app left it unchanged.");
    }
  }

  /**
   * The person's first and last name when the user read last has others;
   * null when they match or the user is unknown.
   */
  private namesToUpdate(userId: string, spec: AccountSpec): Names | null {
    const user = this.users.get(userId);
    const wanted: Names = { firstName: spec.firstName, lastName: spec.lastName };
    if (user === undefined || Object.entries(wanted).every(([key, value]) => (user[key] || "") === value)) {
      return null;
    }
    return wanted;
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    const accounts: ExternalAccount[] = [];
    for await (const user of this.pages(this.adminPath("users"), "list users", {
      briefRepresentation: "false",
    })) {
      if (truthy(user.serviceAccountClientLink)) continue;
      accounts.push(this.remember(user));
    }
    return accounts;
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    const adminConsole = `the Keycloak admin console, realm ${this.realm || "(not set)"}`;
    if (action === "disable_account") {
      return (
        `In ${adminConsole}, open Users, find ${who}, turn Enabled off and sign the user ` +
        "out of all sessions. Remove the groups this app manages."
      );
    }
    const lines = [`In ${adminConsole}, make sure ${who} exists under Users and is enabled.`];
    if (groups.length > 0) lines.push(`Groups: ${groups.join(", ")}.`);
    return lines.join("\n");
  }
}
