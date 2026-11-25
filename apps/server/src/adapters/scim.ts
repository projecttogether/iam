/** Any app with a SCIM 2.0 endpoint (RFC 7643 and RFC 7644). */

import {
  Adapter,
  AdapterError,
  SYNC_INTERVAL_FIELD,
  displayName,
  ensureResult,
  externalAccount,
  externalGroup,
  field,
  type AccountPlan,
  type AccountSpec,
  type AdapterOptions,
  type EnsureResult,
  type ExternalAccount,
  type ExternalGroup,
  type TestResult,
  casefold,
} from "./base";
import type { HttpClient, HttpResponse, RequestOptions } from "./http";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const NEEDS_USER_NAME = "SCIM accounts need a work email or username.";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
/** Answers of servers that do not support a filter or a PATCH form. */
const UNSUPPORTED: readonly number[] = [400, 501];

/** A JSON object as the app sends it. */
type Json = Record<string, unknown>;
type Params = NonNullable<RequestOptions["params"]>;

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

/** The entries of a JSON list; none for anything else. */
function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Python's `quote(value, safe="")`: every character but letters, digits and _.-~ percent-encoded. */
function quote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function flag(value: unknown): boolean {
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return truthy(value);
}

function filterValue(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

/** The body as a JSON object; empty for no body, or one that is no JSON object. */
function jsonObject(response: HttpResponse): Json {
  if (response.status === 204 || !response.text) return {};
  let data: unknown;
  try {
    data = response.json();
  } catch {
    return {};
  }
  return isObject(data) ? data : {};
}

function toAccount(resource: Json): ExternalAccount {
  let email = "";
  for (const entry of entries(resource.emails)) {
    if (isObject(entry) && truthy(entry.value)) {
      if (truthy(entry.primary) || !email) email = String(entry.value);
    }
  }
  let shownName = str(resource.displayName);
  const name = resource.name;
  if (!shownName && isObject(name)) {
    shownName = [name.givenName, name.familyName].filter(truthy).map(String).join(" ");
  }
  let groups: Set<string> | null = null;
  if (Array.isArray(resource.groups)) {
    groups = new Set(
      resource.groups
        .filter(isObject)
        .filter((group) => truthy(group.value))
        .map((group) => String(group.value)),
    );
  }
  const active = resource.active;
  return externalAccount(String(resource.id ?? ""), {
    username: str(resource.userName),
    email,
    displayName: shownName,
    active: active === undefined || active === null ? true : flag(active),
    groups,
  });
}

function values(resource: Json, attribute: string): Set<string> {
  if (attribute === "userName") return new Set([casefold(str(resource.userName))]);
  return new Set(
    entries(resource.emails)
      .filter(isObject)
      .map((entry) => casefold(str(entry.value))),
  );
}

export class ScimAdapter extends Adapter {
  static override readonly slug = "scim";
  static override readonly label = "SCIM 2.0 app";
  static override readonly description =
    "Creates, disables and groups accounts in any app with a SCIM 2.0 endpoint, " +
    "for example Atlassian, Zoom, Miro or GitHub Enterprise.";
  static override readonly supportsGroups = true;
  static override readonly fields = [
    field("base_url", "SCIM base URL", {
      kind: "url",
      required: true,
      destination: true,
      placeholder: "https://app.example.invalid/scim/v2",
      help: "The URL that /Users and /Groups follow.",
    }),
    field("token", "Bearer token", { kind: "secret", required: true }),
    field("user_name_source", "User name", {
      kind: "choice",
      default: "email",
      choices: [
        ["email", "Work email"],
        ["username", "Username"],
      ],
      help: "What the app's userName holds.",
    }),
    field("deactivate_mode", "When access ends", {
      kind: "choice",
      default: "active_false",
      choices: [
        ["active_false", "Deactivate the user (active = false)"],
        ["delete", "Delete the user"],
      ],
    }),
    field("groups_enabled", "Manage groups", {
      kind: "bool",
      default: true,
      help: "Turn off for apps without a /Groups endpoint.",
    }),
    SYNC_INTERVAL_FIELD,
  ];

  static override groupsEnabled(settings: Record<string, unknown>): boolean {
    const value = settings.groups_enabled;
    return flag(value === undefined ? true : value);
  }

  constructor(config: Record<string, unknown>, options: AdapterOptions = {}) {
    super(config, options);
    // Instance value: apps without /Groups manage accounts only.
    this.supportsGroups = flag(this.setting("groups_enabled", true));
  }

  // -- HTTP ---------------------------------------------------------------

  private client(): HttpClient {
    this.require("base_url", "token");
    return this.http(String(this.setting("base_url")).replace(/\/+$/, ""), {
      headers: {
        Authorization: `Bearer ${String(this.setting("token"))}`,
        Accept: "application/scim+json, application/json",
      },
    });
  }

  /** A request whose failures become adapter errors; an error status too, unless `allow` lists it. */
  private async transmit(
    method: string,
    url: string,
    what: string,
    options: { allow?: readonly number[]; body?: Json; params?: Params } = {},
  ): Promise<HttpResponse> {
    const request: RequestOptions = {};
    if (options.params && Object.keys(options.params).length > 0) request.params = options.params;
    if (options.body !== undefined) {
      request.body = JSON.stringify(options.body);
      request.headers = { "Content-Type": "application/scim+json" };
    }
    const response = await this.send(this.client(), method, url, what, request);
    if (options.allow?.includes(response.status)) return response;
    this.raiseForStatus(response, what);
    return response;
  }

  /**
   * The resources of a list response and its totalResults. Anything
   * else is an error: read as an empty list, a maintenance page would
   * mark every account and group missing.
   */
  private listing(response: HttpResponse, what: string): { resources: Json[]; total: unknown } {
    let data: unknown;
    try {
      data = response.json();
    } catch (error) {
      throw new AdapterError(`${this.label} sent an unreadable answer (${what}).`, { cause: error });
    }
    let resources = isObject(data) ? data.Resources : null;
    if ((resources === undefined || resources === null) && isObject(data) && data.totalResults === 0) {
      resources = []; // RFC 7644 lets an empty list leave Resources out
    }
    if (!isObject(data) || !Array.isArray(resources) || !resources.every(isObject)) {
      throw new AdapterError(`${this.label} sent an unexpected answer (${what}).`);
    }
    return { resources: resources as Json[], total: data.totalResults };
  }

  // -- mapping --------------------------------------------------------------

  private userName(spec: AccountSpec): string {
    if (this.setting("user_name_source") === "username") return spec.username || spec.email;
    return spec.email || spec.username;
  }

  /**
   * The one user whose attribute is the value. The answer is checked:
   * a server can ignore a filter and list everyone, and emails need not
   * be unique.
   */
  private async findUser(
    attribute: string,
    value: string,
    options: { tolerateUnsupported: boolean },
  ): Promise<Json | null> {
    const response = await this.transmit("GET", "/Users", "look up a user", {
      allow: options.tolerateUnsupported ? UNSUPPORTED : [],
      params: { filter: `${attribute} eq ${filterValue(value)}`, count: "2" },
    });
    if (UNSUPPORTED.includes(response.status)) return null;
    const wanted = casefold(value);
    const { resources } = this.listing(response, "look up a user");
    const matches = resources.filter((resource) => values(resource, attribute).has(wanted));
    if (matches.length > 1) {
      throw new AdapterError(
        `Several ${this.label} users have the ${attribute} ${value}. Nothing was changed.`,
      );
    }
    return matches[0] ?? null;
  }

  // -- connection -------------------------------------------------------------

  override async testConnection(): Promise<TestResult> {
    let serviceConfig: HttpResponse;
    try {
      serviceConfig = await this.transmit(
        "GET",
        "/ServiceProviderConfig",
        "read the service provider configuration",
        { allow: [404] },
      );
      // The configuration may be public; listing one user proves the token.
      await this.transmit("GET", "/Users", "list users", { params: { count: "1" } });
    } catch (error) {
      if (error instanceof AdapterError) return { ok: false, message: error.message };
      throw error;
    }
    if (serviceConfig.status === 404)
      return { ok: true, message: "Connected. The app lists users over SCIM." };
    const patch = jsonObject(serviceConfig).patch;
    if (isObject(patch) && patch.supported === false) {
      return {
        ok: true,
        message:
          "Connected, but the app reports no PATCH support: disabling users and " + "group changes may fail.",
      };
    }
    return { ok: true, message: "Connected to the SCIM endpoint." };
  }

  // -- accounts -----------------------------------------------------------------

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    if (externalId) {
      const response = await this.transmit("GET", `/Users/${quote(externalId)}`, "read a user", {
        allow: [404],
      });
      if (response.status !== 404) {
        const resource = jsonObject(response);
        // A page that is no user (maintenance, a sign-in page) must not stand
        // for the account: the job would then count it as changed.
        if (!truthy(resource.id))
          throw new AdapterError(`${this.label} sent an unexpected answer (read a user).`);
        return toAccount(resource);
      }
    }
    const userName = this.userName(spec);
    if (userName) {
      const resource = await this.findUser("userName", userName, { tolerateUnsupported: false });
      if (resource !== null) {
        const emails = entries(resource.emails)
          .filter(isObject)
          .map((entry) => entry.value);
        this.checkSameEmail(userName, emails, spec);
        return toAccount(resource);
      }
    }
    // Also when the userName is the email: the user may have another userName.
    if (spec.email) {
      const resource = await this.findUser("emails.value", spec.email, { tolerateUnsupported: true });
      if (resource !== null) return toAccount(resource);
    }
    return null;
  }

  override async createAccount(spec: AccountSpec): Promise<EnsureResult> {
    const userName = this.userName(spec);
    if (!userName) throw new AdapterError(NEEDS_USER_NAME);
    const body: Json = {
      schemas: [USER_SCHEMA],
      userName,
      name: { givenName: spec.firstName, familyName: spec.lastName },
      displayName: displayName(spec),
      active: true,
    };
    if (spec.email) body.emails = [{ value: spec.email, primary: true, type: "work" }];
    if (spec.jobTitle) body.title = spec.jobTitle;
    const response = await this.transmit("POST", "/Users", "create a user", { allow: [409], body });
    if (response.status === 409) {
      const account = await this.findAccount(spec);
      if (account === null) {
        throw new AdapterError(
          `${this.label} reports that the user already exists, but no user ` +
            "matches its user name or email.",
        );
      }
      const result = ensureResult(account, { notes: ["The user already existed."] });
      if (!account.active) {
        result.account = await this.setActive(account, true);
        result.reactivated = true;
      }
      return result;
    }
    return ensureResult(toAccount(jsonObject(response)), { created: true });
  }

  override async planEnsure(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planEnsure(spec, account);
    if (plan.change === "create" && !this.userName(spec)) plan.refusal = NEEDS_USER_NAME;
    return plan;
  }

  override async planDisable(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planDisable(spec, account);
    if (plan.change === "disable" && this.deletesUsers()) plan.change = "delete";
    return plan;
  }

  private deletesUsers(): boolean {
    return this.setting("deactivate_mode") === "delete";
  }

  override async setActive(account: ExternalAccount, active: boolean): Promise<ExternalAccount> {
    const path = `/Users/${quote(account.externalId)}`;
    if (!active && this.deletesUsers()) {
      await this.transmit("DELETE", path, "delete a user", { allow: [404] });
      return { ...account, active: false, groups: new Set() };
    }
    const operations: Json[][] = [
      [{ op: "replace", path: "active", value: active }],
      // Some servers only accept the value form without a path.
      [{ op: "replace", value: { active } }],
    ];
    let response: HttpResponse | null = null;
    for (const [index, operation] of operations.entries()) {
      const last = index === operations.length - 1;
      response = await this.transmit("PATCH", path, active ? "activate a user" : "deactivate a user", {
        allow: last ? [] : UNSUPPORTED,
        body: { schemas: [PATCH_SCHEMA], Operations: operation },
      });
      if (!UNSUPPORTED.includes(response.status)) break;
    }
    const data = response !== null ? jsonObject(response) : {};
    if (truthy(data.id)) {
      const updated = toAccount(data);
      if (updated.groups === null) updated.groups = account.groups;
      return updated;
    }
    return { ...account, active };
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    return (await this.paged("/Users", "list users")).map(toAccount);
  }

  // -- groups ---------------------------------------------------------------------

  /**
   * Every page of a listing. With `unsupported`, a server that refuses
   * the request (400, 501) raises that message.
   */
  private async paged(url: string, what: string, params: Params = {}, unsupported = ""): Promise<Json[]> {
    const all: Json[] = [];
    let start = 1;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.transmit("GET", url, what, {
        allow: unsupported ? UNSUPPORTED : [],
        params: { ...params, startIndex: String(start), count: String(PAGE_SIZE) },
      });
      if (UNSUPPORTED.includes(response.status) && unsupported) throw new AdapterError(unsupported);
      const { resources, total } = this.listing(response, what);
      all.push(...resources);
      start += resources.length;
      if (resources.length === 0 || (typeof total === "number" && Number.isInteger(total) && start > total)) {
        break;
      }
    }
    return all;
  }

  override async listGroups(): Promise<ExternalGroup[]> {
    if (!this.supportsGroups) return [];
    const groups = await this.paged("/Groups", "list groups", { attributes: "displayName" });
    return groups
      .filter((group) => truthy(group.id))
      .map((group) => externalGroup(String(group.id), str(group.displayName) || String(group.id)));
  }

  override async accountGroups(account: ExternalAccount): Promise<Set<string>> {
    if (account.groups !== null) return new Set(account.groups);
    if (!this.supportsGroups) return new Set();
    // Unknown memberships must not read as none: nothing would be removed.
    const groups = await this.paged(
      "/Groups",
      "read a user's groups",
      {
        filter: `members.value eq ${filterValue(account.externalId)}`,
        attributes: "displayName",
      },
      `${this.label} cannot list a user's groups (no members filter). Change the ` +
        "groups by hand, or turn off Manage groups for this connection.",
    );
    return new Set(groups.filter((group) => truthy(group.id)).map((group) => String(group.id)));
  }

  override async addToGroup(account: ExternalAccount, groupId: string): Promise<void> {
    await this.transmit("PATCH", `/Groups/${quote(groupId)}`, "add a user to a group", {
      body: {
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: "add", path: "members", value: [{ value: account.externalId }] }],
      },
    });
  }

  override async removeFromGroup(account: ExternalAccount, groupId: string): Promise<void> {
    await this.transmit("PATCH", `/Groups/${quote(groupId)}`, "remove a user from a group", {
      body: {
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: "remove", path: `members[value eq ${filterValue(account.externalId)}]` }],
      },
    });
  }
}
