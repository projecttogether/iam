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
  type AccountPlan,
  type AccountSpec,
  type EnsureResult,
  type ExternalAccount,
  type ExternalGroup,
  type JobActionName,
  type TestResult,
} from "./base";
import type { HttpClient, RequestOptions } from "./http";

/**
 * Relution (mobile device management): users and group memberships.
 *
 * API contract, as verified against the Relution cloud:
 *
 * - Every request authenticates with the header `X-User-Access-Token`. Use the
 *   token of a Relution user that may only look up the organization's users and
 *   manage their group memberships.
 * - Users live at `/api/management/v1/security/users`, groups at
 *   `/api/management/v1/security/groups`. Listings take `limit`/`offset`
 *   and answer with an `items` array. There is no verified server-side email
 *   filter, so lookups page through the organization's roster.
 * - A shared Relution cloud can return entities of other organizations; items
 *   whose `organizationUuid` differs from the configured one are ignored.
 * - The API rejects PATCH. Updates are full-object PUTs, so the adapter merges
 *   its change over the fetched user and drops any password, credential, secret
 *   or token fields before sending it back.
 * - User objects carry `activated`/`locked`/`ssoOnly` and do not embed
 *   group memberships. Memberships are read with GET and replaced with PUT on
 *   `/users/<uuid>/groups`; the PUT body is a bare JSON array of group UUIDs.
 *
 * Disabling sets `activated` to false. The adapter never deletes users:
 * deleting a Relution user also affects the devices enrolled for that user,
 * which IT should retire on purpose, not as a side effect of offboarding. For
 * the same reason memberships stay in place when an account is disabled, so
 * group-based policies and apps are not pulled from devices still in use.
 * The adapter never creates groups and never sets a password: new users are
 * SSO-only by default and sign in through the organization's identity provider.
 */

export const USERS_PATH = "/api/management/v1/security/users";
export const GROUPS_PATH = "/api/management/v1/security/groups";
const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SENSITIVE_KEY_PARTS = ["password", "credential", "secret", "token"];
const INACTIVE_STATES = new Set(["disabled", "inactive", "suspended", "archived"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const NEEDS_EMAIL = "A Relution account needs the person's work email.";
const LOCKED =
  "The Relution user is locked. Nothing was changed. Unlock it in Relution, then run the job again.";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truthiness: empty lists and objects count as nothing too. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function flag(value: unknown): boolean {
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function normalize(value: string): string {
  return (value || "").trim().toLowerCase();
}

/** `value or ""` as text. */
function str(value: unknown): string {
  return truthy(value) ? String(value) : "";
}

function entityId(item: Json): string {
  const value = truthy(item.uuid) ? item.uuid : item.id;
  return truthy(value) ? String(value) : "";
}

/** A path segment, percent-encoded like Python's quote(value, safe=''). */
function quote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function userIsActive(user: Json): boolean {
  if (user.enabled === false || user.active === false || user.activated === false || user.locked === true) {
    return false;
  }
  const status = str(truthy(user.status) ? user.status : user.state).toLowerCase();
  return !INACTIVE_STATES.has(status);
}

/**
 * Group IDs from a membership response, or null when it holds none of the
 * known shapes.
 */
export function membershipIds(data: unknown): Set<string> | null {
  let raw: unknown;
  if (Array.isArray(data)) {
    raw = data;
  } else if (isRecord(data)) {
    const present = ["groups", "roles", "userGroups", "items"].filter((key) => Object.hasOwn(data, key));
    if (present.length === 0) return null;
    const key = present.find((name) => truthy(data[name]));
    raw = key === undefined ? [] : data[key];
  } else {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const ids = new Set<string>();
  for (const entry of raw as unknown[]) {
    const value = isRecord(entry) ? entityId(entry) : entry;
    if (truthy(value)) ids.add(String(value));
  }
  return ids;
}

/**
 * Memberships a user object carries itself; listings usually carry none.
 * A user's roles are permissions, not group memberships.
 */
export function membershipIdsEmbedded(user: Json): Set<string> | null {
  const keys = ["groups", "userGroups"].filter((key) => Object.hasOwn(user, key));
  if (keys.length === 0) return null;
  return membershipIds(Object.fromEntries(keys.map((key) => [key, user[key]])));
}

/**
 * Whether the user is activated, even if locked now: unlocking it would let
 * the person in again.
 */
export function canSignInLater(user: Json): boolean {
  if (Object.hasOwn(user, "activated")) return user.activated !== false;
  return userIsActive(user);
}

/** A full-object PUT body that never replays credential material. */
export function updatePayload(user: Json, changes: Json): Json {
  return Object.fromEntries(
    Object.entries({ ...user, ...changes }).filter(
      ([key]) => !SENSITIVE_KEY_PARTS.some((part) => key.toLowerCase().includes(part)),
    ),
  );
}

export class RelutionAdapter extends Adapter {
  static override readonly slug = "relution";
  static override readonly label = "Relution";
  static override readonly description =
    "Mobile device management. Creates SSO-only users, keeps their group " +
    "memberships, and deactivates users on offboarding. Never deletes users, so " +
    "enrolled devices are not affected.";
  static override readonly supportsGroups = true;
  static override readonly removeGroupsOnDisable = false;
  static override readonly groupLabel = "Relution groups";
  static override readonly fields = [
    field("base_url", "Relution address", {
      kind: "url",
      required: true,
      destination: true,
      placeholder: "https://relution.example.invalid",
      help: "The origin only, without a path.",
    }),
    field("organization_uuid", "Organization UUID", {
      required: true,
      help: "Users are created in this organization; others are ignored.",
    }),
    field("api_token", "API access token", {
      kind: "secret",
      required: true,
      help: "Token of a Relution user that may only manage the organization's users and group memberships.",
    }),
    field("sso_only", "Sign in only through single sign-on", {
      kind: "bool",
      default: true,
      help: "New users get no Relution password.",
    }),
    field("managed_apple_id", "Use the work email as managed Apple ID", { kind: "bool", default: true }),
    SYNC_INTERVAL_FIELD,
  ];

  /** Whether each user read so far is activated (even if locked), and whether it is locked. */
  private readonly activated = new Map<string, boolean>();
  private readonly locked = new Map<string, boolean>();

  // -- HTTP ------------------------------------------------------------------

  private baseUrl(): string {
    this.require("base_url", "organization_uuid", "api_token");
    const baseUrl = String(this.setting("base_url")).replace(/\/+$/, "");
    let parts: URL | null;
    try {
      parts = new URL(baseUrl);
    } catch {
      parts = null;
    }
    if (
      parts === null ||
      !parts.host ||
      parts.username ||
      parts.password ||
      parts.search ||
      parts.hash ||
      !["", "/"].includes(parts.pathname)
    ) {
      throw new ConfigurationError("The Relution address must be an origin without credentials or a path.");
    }
    if (parts.protocol !== "https:" && !(parts.protocol === "http:" && LOCAL_HOSTS.has(parts.hostname))) {
      throw new ConfigurationError("The Relution address must use HTTPS.");
    }
    return baseUrl;
  }

  get organizationUuid(): string {
    return String(this.setting("organization_uuid", ""));
  }

  private client(): HttpClient {
    return this.http(this.baseUrl(), {
      headers: {
        Accept: "application/json",
        "X-User-Access-Token": String(this.setting("api_token")),
      },
    });
  }

  /**
   * Sends one request; returns the parsed JSON, null for an empty body, or
   * null for 404 when `allow404`.
   */
  private async request(
    method: string,
    path: string,
    what: string,
    options: RequestOptions & { allow404?: boolean } = {},
  ): Promise<unknown> {
    const { allow404 = false, ...request } = options;
    const response = await this.send(this.client(), method, path, what, request);
    if (allow404 && response.status === 404) return null;
    // Provider bodies can echo request fields; only the status is kept.
    this.raiseForStatus(response, what);
    const content = response.text;
    if (Buffer.byteLength(content, "utf8") > MAX_RESPONSE_BYTES) {
      throw new AdapterError(`Relution's answer was too large (${what}).`);
    }
    if (response.status === 204 || !content) return null;
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
      throw new AdapterError(`Relution did not answer with JSON (${what}).`);
    }
    try {
      return response.json();
    } catch (error) {
      throw new AdapterError(`Relution answered with malformed JSON (${what}).`, { cause: error });
    }
  }

  private page(data: unknown, what: string): Json[] {
    let results: unknown = null;
    if (Array.isArray(data)) results = data;
    else if (isRecord(data)) results = Object.hasOwn(data, "items") ? data.items : data.results;
    if (!Array.isArray(results) || results.some((item) => !isRecord(item))) {
      throw new AdapterError(`Relution answered in an unexpected shape (${what}).`);
    }
    return results as Json[];
  }

  private inOrganization(item: Json): boolean {
    // Entities without the field cannot be scoped; the token is bound to one
    // organization, so they are kept.
    const value = str(item.organizationUuid);
    return !value || value.toLowerCase() === this.organizationUuid.toLowerCase();
  }

  private async list(path: string, what: string): Promise<Json[]> {
    const items: Json[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.request("GET", path, what, {
        params: { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      });
      const results = this.page(data, what);
      items.push(...results.filter((item) => this.inOrganization(item)));
      if (results.length < PAGE_SIZE) return items;
    }
    throw new AdapterError(`Relution listed more than ${MAX_PAGES * PAGE_SIZE} entries (${what}).`);
  }

  // -- users -----------------------------------------------------------------

  private userPath(userId: string): string {
    return `${USERS_PATH}/${quote(userId)}`;
  }

  private async getUser(userId: string): Promise<Json | null> {
    const data = await this.request("GET", this.userPath(userId), "read a user", { allow404: true });
    if (data === null) return null;
    if (!isRecord(data) || !entityId(data)) {
      throw new AdapterError("Relution answered in an unexpected shape (read a user).");
    }
    return data;
  }

  private toAccount(user: Json): ExternalAccount {
    this.activated.set(entityId(user), canSignInLater(user));
    this.locked.set(entityId(user), user.locked === true);
    const ids = membershipIdsEmbedded(user);
    return externalAccount(entityId(user), {
      username: str(user.name),
      email: normalize(str(user.email)),
      displayName: [user.givenName, user.surname]
        .filter((part) => truthy(part))
        .map(String)
        .join(" "),
      active: userIsActive(user),
      groups: ids,
    });
  }

  private async match(spec: AccountSpec): Promise<Json | null> {
    const email = normalize(spec.email);
    const username = normalize(spec.username);
    const users = (await this.list(USERS_PATH, "list users")).filter((user) => entityId(user));
    let matches: Json[] = [];
    if (email) {
      matches = users.filter(
        (user) => normalize(str(user.email)) === email || normalize(str(user.name)) === email,
      );
    }
    if (matches.length === 0 && username) {
      matches = users.filter((user) => normalize(str(user.name)) === username);
    }
    if (matches.length > 1) {
      throw new AdapterError("Several Relution users match this person. Link the right one in Relution.");
    }
    const user = matches[0];
    if (user === undefined) return null;
    // A match by login name must also have the person's email, if any.
    this.checkSameEmail(str(user.name), [user.email], spec);
    return user;
  }

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    if (externalId) {
      const user = await this.getUser(externalId);
      // The stored ID proves ownership even after an email change.
      if (user !== null) return this.toAccount(user);
    }
    const user = await this.match(spec);
    return user ? this.toAccount(user) : null;
  }

  override async createAccount(spec: AccountSpec): Promise<EnsureResult> {
    const email = normalize(spec.email);
    if (!email) throw new AdapterError(NEEDS_EMAIL);
    const payload: Json = {
      organizationUuid: this.organizationUuid,
      name: email,
      email,
      givenName: spec.firstName,
      surname: spec.lastName,
      ssoOnly: flag(this.setting("sso_only", true)),
      activated: true,
    };
    if (flag(this.setting("managed_apple_id", true))) payload.managedAppleId = email;
    let created: unknown;
    let failure: TransientError | null = null;
    try {
      created = await this.request("POST", USERS_PATH, "create a user", { json: payload });
    } catch (error) {
      if (!(error instanceof TransientError)) throw error;
      failure = error;
    }
    let user: Json | null;
    if (failure !== null) {
      // A create that timed out or failed on the server may still have been
      // stored. Read before a retry can create a duplicate.
      user = await this.match(spec);
      if (user === null) throw failure;
    } else {
      user = isRecord(created) && entityId(created) ? created : await this.match(spec);
    }
    if (user === null) throw new AdapterError("Relution did not return the new user.");
    const account = this.toAccount(user);
    account.groups = new Set();
    return ensureResult(account, { created: true });
  }

  override async setActive(account: ExternalAccount, active: boolean): Promise<ExternalAccount> {
    const user = await this.getUser(account.externalId);
    if (user === null) {
      if (!active) {
        // Already gone: nothing left that could sign in.
        account.active = false;
        return account;
      }
      throw new AdapterError("The Relution user no longer exists.");
    }
    // Deactivating writes also for a locked user: a lock is not an end.
    const needsWrite = active ? !userIsActive(user) : canSignInLater(user);
    if (needsWrite) {
      await this.request(
        "PUT",
        this.userPath(account.externalId),
        active ? "activate a user" : "deactivate a user",
        {
          allow404: !active,
          json: updatePayload(user, { activated: active }),
        },
      );
    }
    const confirmed = await this.getUser(account.externalId);
    if (confirmed === null) {
      if (!active) {
        account.active = false;
        return account;
      }
      throw new AdapterError("The Relution user disappeared while it was activated.");
    }
    if ((active ? userIsActive(confirmed) : canSignInLater(confirmed)) !== active) {
      throw new AdapterError(
        active
          ? "Relution did not confirm the user as active; it may be locked in Relution."
          : "Relution did not confirm the user as deactivated.",
      );
    }
    const updated = this.toAccount(confirmed);
    updated.groups = account.groups;
    return updated;
  }

  override async planEnsure(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planEnsure(spec, account);
    if (plan.change === "create" && !normalize(spec.email)) {
      plan.refusal = NEEDS_EMAIL;
    } else if (plan.change === "reactivate" && account !== null && this.locked.get(account.externalId)) {
      // Activating does not unlock: a person decides why it is locked.
      plan.refusal = LOCKED;
    }
    return plan;
  }

  override async planDisable(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planDisable(spec, account);
    if (plan.change === "already disabled" && account !== null && this.activated.get(account.externalId)) {
      // A locked user counts as inactive but stays activated: unlocking it
      // would let the person in again.
      plan.change = "disable";
    }
    return plan;
  }

  // -- groups ----------------------------------------------------------------

  override async listGroups(): Promise<ExternalGroup[]> {
    const groups: ExternalGroup[] = [];
    for (const group of await this.list(GROUPS_PATH, "list groups")) {
      const groupId = entityId(group);
      if (!groupId) continue;
      groups.push(
        externalGroup(groupId, (truthy(group.name) ? String(group.name) : groupId).trim(), {
          description: str(group.description),
        }),
      );
    }
    return groups;
  }

  private async membership(userId: string): Promise<Set<string>> {
    const data = await this.request("GET", `${this.userPath(userId)}/groups`, "read group memberships");
    const ids = membershipIds(data);
    if (ids === null) {
      throw new AdapterError("Relution answered in an unexpected shape (read group memberships).");
    }
    return ids;
  }

  private async replaceMembership(userId: string, groupIds: Set<string>, what: string): Promise<Set<string>> {
    await this.request("PUT", `${this.userPath(userId)}/groups`, what, { json: [...groupIds].sort() });
    return this.membership(userId);
  }

  override async accountGroups(account: ExternalAccount): Promise<Set<string>> {
    if (account.groups !== null) return new Set(account.groups);
    return this.membership(account.externalId);
  }

  override async addToGroup(account: ExternalAccount, groupId: string): Promise<void> {
    const current = await this.membership(account.externalId);
    if (current.has(groupId)) return;
    const confirmed = await this.replaceMembership(
      account.externalId,
      new Set([...current, groupId]),
      "add a group membership",
    );
    if (!confirmed.has(groupId)) throw new AdapterError("Relution did not confirm the new group membership.");
  }

  override async removeFromGroup(account: ExternalAccount, groupId: string): Promise<void> {
    const current = await this.membership(account.externalId);
    if (!current.has(groupId)) return;
    const confirmed = await this.replaceMembership(
      account.externalId,
      new Set([...current].filter((id) => id !== groupId)),
      "remove a group membership",
    );
    if (confirmed.has(groupId))
      throw new AdapterError("Relution did not confirm the removed group membership.");
  }

  // -- reads -----------------------------------------------------------------

  override async listAccounts(): Promise<ExternalAccount[]> {
    // Listings do not embed memberships, so groups stay unknown (null).
    return (await this.list(USERS_PATH, "list users"))
      .filter((user) => entityId(user))
      .map((user) => this.toAccount(user));
  }

  override async testConnection(): Promise<TestResult> {
    for (const [path, what] of [
      [USERS_PATH, "list users"],
      [GROUPS_PATH, "list groups"],
    ] as const) {
      this.page(await this.request("GET", path, what, { params: { limit: 1, offset: 0 } }), what);
    }
    return { ok: true, message: "Connected. Relution lists users and groups for this token." };
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    if (action === "disable_account") {
      return (
        `In Relution, deactivate the user of ${who}. Do not delete the user: that ` +
        "also affects the enrolled devices. Retire devices separately."
      );
    }
    const lines = [
      `In Relution, make sure ${who} has an activated, SSO-only user with the work email as login name.`,
    ];
    if (groups.length > 0) lines.push(`Relution groups: ${groups.join(", ")}.`);
    return lines.join("\n");
  }
}
