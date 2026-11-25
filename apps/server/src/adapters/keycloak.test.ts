import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, overrideConfigForTests } from "../config";
import {
  answer,
  json,
  mockFetch,
  timeoutError,
  connectError,
  type Handler,
  type SeenRequest,
} from "../test/mock-fetch";
import {
  AdapterError,
  ConfigurationError,
  TransientError,
  accountSpec,
  readOnly,
  type AccountPlan,
  type AccountSpec,
  type Adapter,
  type JobActionName,
} from "./base";
import { KeycloakAdapter } from "./keycloak";

const BASE = "https://sso.example.invalid";
const REALM = "example";
const ADMIN = `/admin/realms/${REALM}`;
const TOKEN_PATH = `/realms/${REALM}/protocol/openid-connect/token`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake's records are read loosely, as in Python
type Loose = Record<string, any>;
type Call = [method: string, path: string, params: Record<string, string>, body: Loose | null];
type FakeGroup = { id: string; name: string; path: string; parent: string | null };

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Just enough of the Keycloak Admin REST API for the adapter. */
class FakeKeycloak {
  users = new Map<string, Loose>();
  memberships = new Map<string, Set<string>>();
  groups = new Map<string, FakeGroup>();
  tokenStatus = 200;
  tokenCalls = 0;
  /** Status codes by "METHOD /path". */
  failures = new Map<string, number>();
  calls: Call[] = [];
  inlineSubgroups = false;
  defaultGroups = new Set<string>();
  private next = 0;

  // -- setup helpers --

  addGroup(groupId: string, name: string, parent: string | null = null): void {
    const parentPath = parent ? this.groups.get(parent)!.path : "";
    this.groups.set(groupId, { id: groupId, name, path: `${parentPath}/${name}`, parent });
  }

  addUser(
    username: string,
    email = "",
    { enabled = true, groups = [], ...extra }: { enabled?: boolean; groups?: Iterable<string> } & Loose = {},
  ): string {
    this.next += 1;
    const userId = `user-${this.next}`;
    const { firstName = "Ada", lastName = "Lovelace", ...rest } = extra;
    this.users.set(userId, {
      id: userId,
      username,
      email,
      firstName,
      lastName,
      enabled,
      access: { manage: true },
      attributes: { department: ["Research"] },
      ...rest,
    });
    this.memberships.set(userId, new Set(groups));
    return userId;
  }

  // -- transport --

  handle = (request: SeenRequest): Response => {
    const path = decodeURIComponent(request.url.pathname);
    const method = request.method;
    const params = Object.fromEntries(request.url.searchParams);
    const body = request.body && path !== TOKEN_PATH ? (request.json() as Loose) : null;
    this.calls.push([method, path, params, body]);
    const failure = this.failures.get(`${method} ${path}`);
    if (failure !== undefined) return json(failure, { error: "secret-ish" });
    if (path === TOKEN_PATH) {
      this.tokenCalls += 1;
      expect(request.form().getAll("grant_type")).toEqual(["client_credentials"]);
      if (this.tokenStatus !== 200) return json(this.tokenStatus, { error: "unauthorized_client" });
      return json(200, { access_token: "tok", expires_in: 300 });
    }
    expect(request.headers.get("authorization")).toBe("Bearer tok");
    expect(path.startsWith(ADMIN)).toBe(true);
    return this.route(method, path.slice(ADMIN.length), params, body);
  };

  route(method: string, path: string, params: Record<string, string>, body: Loose | null): Response {
    const parts = path.split("/").filter(Boolean);
    const first = Number(params.first ?? 0);
    const size = Number(params.max ?? 100);
    if (same(parts, ["users", "count"])) return json(200, this.users.size);
    if (same(parts, ["users"]) && method === "GET") {
      let users = [...this.users.values()];
      for (const field of ["username", "email"]) {
        const value = params[field];
        if (value !== undefined)
          users = users.filter((user) => user[field].toLowerCase() === value.toLowerCase());
      }
      return json(200, users.slice(first, first + size));
    }
    if (same(parts, ["users"]) && method === "POST") {
      if ([...this.users.values()].some((user) => user.username === body!.username)) {
        return json(409, { errorMessage: "User exists" });
      }
      const userId = this.addUser(body!.username, body!.email ?? "", {
        firstName: body!.firstName,
        lastName: body!.lastName,
      });
      this.users.get(userId)!.enabled = body!.enabled;
      for (const group of this.defaultGroups) this.memberships.get(userId)!.add(group);
      return answer(201, "", { Location: `${BASE}${ADMIN}/users/${userId}` });
    }
    if (parts[0] === "users" && parts.length >= 2) {
      const userId = parts[1]!;
      const user = this.users.get(userId);
      if (user === undefined) return answer(404);
      const rest = parts.slice(2);
      if (rest.length === 0 && method === "GET") return json(200, user);
      if (rest.length === 0 && method === "PUT") {
        expect(body).not.toHaveProperty("access");
        Object.assign(user, body);
        return answer(204);
      }
      if (same(rest, ["logout"]) && method === "POST") return answer(204);
      if ((same(rest, ["execute-actions-email"]) || same(rest, ["reset-password"])) && method === "PUT") {
        return answer(204);
      }
      if (same(rest, ["groups"]) && method === "GET") {
        const ids = [...this.memberships.get(userId)!].sort();
        const page = ids.slice(first, first + size).map((id) => {
          const group = this.groups.get(id)!;
          return { id, name: group.name, path: group.path };
        });
        return json(200, page);
      }
      if (rest[0] === "groups" && rest.length === 2) {
        const groupId = rest[1]!;
        if (!this.groups.has(groupId)) return answer(404);
        if (method === "PUT") this.memberships.get(userId)!.add(groupId);
        else this.memberships.get(userId)!.delete(groupId);
        return answer(204);
      }
    }
    if (same(parts, ["default-groups"]) && method === "GET") {
      return json(
        200,
        [...this.defaultGroups].sort().map((id) => {
          const group = this.groups.get(id)!;
          return { id, name: group.name, path: group.path };
        }),
      );
    }
    if (same(parts, ["groups"])) return json(200, this.groupPage(null, params));
    if (parts[0] === "groups" && same(parts.slice(2), ["children"])) {
      return json(200, this.groupPage(parts[1]!, params));
    }
    return answer(404);
  }

  groupRep(group: FakeGroup): Loose {
    const children = [...this.groups.values()].filter((child) => child.parent === group.id);
    const rep: Loose = { id: group.id, name: group.name, path: group.path };
    if (this.inlineSubgroups) {
      rep.subGroups = children.map((child) => this.groupRep(child));
    } else {
      rep.subGroupCount = children.length;
      rep.subGroups = [];
    }
    return rep;
  }

  groupPage(parent: string | null, params: Record<string, string>): Loose[] {
    const groups = [...this.groups.values()]
      .filter((group) => group.parent === parent)
      .map((group) => this.groupRep(group));
    const first = Number(params.first ?? 0);
    const size = Number(params.max ?? 100);
    return groups.slice(first, first + size);
  }

  callsTo(method: string, suffix: string): Call[] {
    return this.calls.filter((call) => call[0] === method && call[1].endsWith(suffix));
  }
}

/**
 * Errors thrown in a handler, such as a failed expect. The adapter's client
 * would turn them into "could not reach" errors; the test fails with them
 * instead, as with httpx.MockTransport.
 */
let handlerErrors: unknown[] = [];

function checked(handler: Handler): Handler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      handlerErrors.push(error);
      throw error;
    }
  };
}

function adapterFor(fake: FakeKeycloak, settings: Record<string, unknown> = {}): KeycloakAdapter {
  const values = {
    base_url: BASE,
    realm: REALM,
    client_id: "iam",
    client_secret: "client-secret-value",
    ...settings,
  };
  return new KeycloakAdapter(values, { fetch: mockFetch(checked(fake.handle)) });
}

function spec(overrides: Partial<AccountSpec> = {}): AccountSpec {
  return accountSpec({
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada",
    email: "ada@example.invalid",
    ...overrides,
  });
}

/** The error a promise fails with, checked like pytest.raises. */
async function raises<E extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => E,
  match?: RegExp,
): Promise<E> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  if (match) expect((caught as E).message).toMatch(match);
  return caught as E;
}

/** The only item of a list. */
function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0]!;
}

/**
 * What the job would do, read through the read-only wrapper as read-only
 * mode does: a step that changes anything throws ReadOnlyError.
 */
async function rehearse(
  adapter: Adapter,
  action: JobActionName,
  person: AccountSpec,
  options: { externalId?: string; groups?: Iterable<string>; managedGroups?: Iterable<string> } = {},
): Promise<AccountPlan> {
  const reader = readOnly(adapter);
  const found = await reader.findAccount(person, options.externalId ?? "");
  return reader.plan(action, person, {
    found,
    groups: new Set(options.groups ?? []),
    managedGroups: new Set(options.managedGroups ?? []),
  });
}

describe("the Keycloak adapter", () => {
  let keycloak: FakeKeycloak;
  let development: boolean;

  beforeEach(() => {
    handlerErrors = [];
    // pytest-django runs with DEBUG=False: plain HTTP only for loopback or with the opt-in.
    development = config().isDevelopment;
    overrideConfigForTests({ isDevelopment: false });
    keycloak = new FakeKeycloak();
    keycloak.addGroup("g-apps", "apps");
    keycloak.addGroup("g-wiki", "wiki", "g-apps");
    keycloak.addGroup("g-editors", "editors", "g-wiki");
    keycloak.addGroup("g-teams", "teams");
    keycloak.addGroup("g-sales", "sales", "g-teams");
    keycloak.addGroup("g-other", "other");
  });

  afterEach(() => {
    overrideConfigForTests({ isDevelopment: development });
    if (handlerErrors.length > 0) throw handlerErrors[0];
  });

  it("reports the user count when the connection works", async () => {
    keycloak.addUser("ada", "ada@example.invalid");
    keycloak.addUser("bob", "bob@example.invalid");
    const result = await adapterFor(keycloak).testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("2 users");
    expect(keycloak.tokenCalls).toBe(1);
  });

  it("names the missing roles on 403", async () => {
    keycloak.failures.set(`GET ${ADMIN}/users/count`, 403);
    const result = await adapterFor(keycloak).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("403");
    expect(result.message).toContain("view-users");
    expect(result.message).not.toContain("secret-ish");
  });

  it("names the admin API scope on 401", async () => {
    // Keycloak 26.8.2 and later: a token without the kc-admin-api audience.
    keycloak.failures.set(`GET ${ADMIN}/users/count`, 401);
    const result = await adapterFor(keycloak).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
    expect(result.message).toContain("kc-admin-api");
    expect(result.message).not.toContain("client-secret-value");
  });

  it("reports a rejected client secret", async () => {
    keycloak.tokenStatus = 401;
    const result = await adapterFor(keycloak).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refused the client ID and secret");
    expect(result.message).not.toContain("client-secret-value");
  });

  it("reports missing settings as a configuration error", async () => {
    const adapter = adapterFor(keycloak, { client_secret: "" });
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Client secret");
  });

  it("refuses plain HTTP outside development", async () => {
    const adapter = adapterFor(keycloak, { base_url: "http://sso.example.invalid" });
    await raises(adapter.listGroups(), ConfigurationError, /HTTPS/);
    const loopback = adapterFor(keycloak, { base_url: "http://localhost:8080" });
    loopback["checkConfig"]();
  });

  it("flattens the group tree", async () => {
    const groups = await adapterFor(keycloak).listGroups();
    expect(Object.fromEntries(groups.map((group) => [group.path, group.externalId]))).toEqual({
      "/apps": "g-apps",
      "/apps/wiki": "g-wiki",
      "/apps/wiki/editors": "g-editors",
      "/teams": "g-teams",
      "/teams/sales": "g-sales",
      "/other": "g-other",
    });
    // Groups without children are not asked for them.
    expect(keycloak.callsTo("GET", "/groups/g-other/children")).toEqual([]);
  });

  it("filters the groups by the group root", async () => {
    const groups = await adapterFor(keycloak, { group_root: "apps/" }).listGroups();
    expect(groups.map((group) => group.path)).toEqual(["/apps/wiki", "/apps/wiki/editors"]);
  });

  it("reads the inline subgroups of older versions", async () => {
    keycloak.inlineSubgroups = true;
    const groups = await adapterFor(keycloak).listGroups();
    expect(groups.map((group) => group.path)).toContain("/apps/wiki/editors");
    expect(keycloak.calls.filter((call) => call[1].endsWith("/children"))).toEqual([]);
  });

  it("creates a user, sends the setup email and adds the groups", async () => {
    const adapter = adapterFor(keycloak);
    const result = await adapter.ensureAccount(spec(), {
      groups: new Set(["g-wiki"]),
      managedGroups: new Set(["g-wiki", "g-sales"]),
    });
    expect(result.created).toBe(true);
    const userId = result.account.externalId;
    const user = keycloak.users.get(userId)!;
    expect(user.username).toBe("ada");
    expect(user.email).toBe("ada@example.invalid");
    expect(user.enabled).toBe(true);
    expect(keycloak.memberships.get(userId)).toEqual(new Set(["g-wiki"]));
    expect(result.groupsAdded).toEqual(["g-wiki"]);
    const call = only(keycloak.callsTo("PUT", "/execute-actions-email"));
    expect(call[2].lifespan).toBe(String(72 * 3600));
    expect(call[3]).toEqual(["UPDATE_PASSWORD"]);
    expect(result.notes.some((note) => note.includes("setup email"))).toBe(true);
    expect(result.initialPassword).toBeNull();
    // Keycloak may add default groups to a new user, so they are read.
    expect(keycloak.callsTo("GET", `/users/${userId}/groups`).length).toBeGreaterThan(0);
    expect(keycloak.tokenCalls).toBe(1);
  });

  it("changes only the managed groups", async () => {
    const userId = keycloak.addUser("ada", "ada@example.invalid", { groups: ["g-sales", "g-other"] });
    const result = await adapterFor(keycloak).ensureAccount(spec(), {
      groups: new Set(["g-wiki"]),
      managedGroups: new Set(["g-wiki", "g-sales"]),
    });
    expect(result.created).toBe(false);
    expect(result.groupsAdded).toEqual(["g-wiki"]);
    expect(result.groupsRemoved).toEqual(["g-sales"]);
    expect(keycloak.memberships.get(userId)).toEqual(new Set(["g-wiki", "g-other"]));
    expect(keycloak.callsTo("PUT", "/execute-actions-email")).toEqual([]);
  });

  it("finds an account by external ID, then by email", async () => {
    const userId = keycloak.addUser("ada.lovelace", "ada@example.invalid");
    const adapter = adapterFor(keycloak);
    const byEmail = await adapter.findAccount(spec());
    expect(byEmail!.externalId).toBe(userId);
    const byId = await adapter.findAccount(spec({ username: "someone-else" }), userId);
    expect(byId!.externalId).toBe(userId);
    expect(await adapter.findAccount(spec({ username: "nobody", email: "" }))).toBeNull();
  });

  it("reactivates a disabled user", async () => {
    const userId = keycloak.addUser("ada", "ada@example.invalid", { enabled: false });
    const result = await adapterFor(keycloak).ensureAccount(spec(), {
      externalId: userId,
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(result.reactivated).toBe(true);
    expect(result.account.active).toBe(true);
    const user = keycloak.users.get(userId)!;
    expect(user.enabled).toBe(true);
    // The whole representation went back, so attributes survive.
    expect(user.attributes).toEqual({ department: ["Research"] });
    expect(keycloak.callsTo("POST", "/logout")).toEqual([]);
  });

  it("updates the names but never the email", async () => {
    const userId = keycloak.addUser("ada", "old@example.invalid", { firstName: "Augusta" });
    const result = await adapterFor(keycloak).ensureAccount(spec(), {
      externalId: userId,
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(keycloak.users.get(userId)!.firstName).toBe("Ada");
    expect(keycloak.users.get(userId)!.email).toBe("old@example.invalid");
    expect(result.notes.some((note) => note.includes("left it unchanged"))).toBe(true);
  });

  it("removes the managed groups, disables and logs out when disabling", async () => {
    const userId = keycloak.addUser("ada", "ada@example.invalid", {
      groups: ["g-wiki", "g-sales", "g-other"],
    });
    const result = await adapterFor(keycloak).disableAccount(spec(), {
      externalId: userId,
      managedGroups: new Set(["g-wiki", "g-sales"]),
    });
    expect(result.changed).toBe(true);
    expect(result.groupsRemoved).toEqual(["g-sales", "g-wiki"]);
    expect(keycloak.memberships.get(userId)).toEqual(new Set(["g-other"]));
    expect(keycloak.users.get(userId)!.enabled).toBe(false);
    expect(keycloak.callsTo("POST", `/users/${userId}/logout`).length).toBeGreaterThan(0);
    expect(result.account!.active).toBe(false);
  });

  it("disables without logout", async () => {
    const userId = keycloak.addUser("ada", "ada@example.invalid");
    await adapterFor(keycloak, { logout_on_disable: false }).disableAccount(spec(), {
      externalId: userId,
      managedGroups: new Set(),
    });
    expect(keycloak.users.get(userId)!.enabled).toBe(false);
    expect(keycloak.callsTo("POST", "/logout")).toEqual([]);
  });

  it("changes nothing when disabling without an account", async () => {
    const result = await adapterFor(keycloak).disableAccount(spec(), { managedGroups: new Set(["g-wiki"]) });
    expect(result.account).toBeNull();
    expect(result.changed).toBe(false);
  });

  it("treats server errors as transient", async () => {
    keycloak.failures.set(`GET ${ADMIN}/users`, 503);
    const error = await raises(adapterFor(keycloak).findAccount(spec()), TransientError);
    expect(error.message).not.toContain("secret-ish");
  });

  it("treats an unreachable Keycloak as transient", async () => {
    const adapter = new KeycloakAdapter(
      { base_url: BASE, realm: REALM, client_id: "iam", client_secret: "s" },
      { fetch: mockFetch(() => connectError()) },
    );
    await raises(adapter.listGroups(), TransientError);
  });

  it("adopts the existing user on a create conflict", async () => {
    const userId = keycloak.addUser("ada", "ada@example.invalid", { enabled: false });
    const result = await adapterFor(keycloak).createAccount(spec());
    expect(result.created).toBe(false);
    expect(result.account.externalId).toBe(userId);
    expect(result.reactivated).toBe(true);
    expect(keycloak.users.get(userId)!.enabled).toBe(true);
    expect(result.notes.some((note) => note.includes("already had"))).toBe(true);
    expect(keycloak.callsTo("PUT", "/execute-actions-email")).toEqual([]);
  });

  it("fails a create conflict with a different email", async () => {
    keycloak.addUser("ada", "someone@example.invalid");
    await raises(adapterFor(keycloak).createAccount(spec()), AdapterError, /different email/);
  });

  it("returns the temporary password for delivery", async () => {
    const adapter = adapterFor(keycloak, { send_setup_email: false, set_temporary_password: true });
    const result = await adapter.createAccount(spec());
    expect(result.initialPassword).toBeTruthy();
    const call = only(keycloak.callsTo("PUT", "/reset-password"));
    expect(call[3]!.temporary).toBe(true);
    expect(call[3]!.value).toBe(result.initialPassword);
  });

  it("turns a failed setup email into a note", async () => {
    const adapter = adapterFor(keycloak);
    // Fail the setup email for the user that will be created next.
    keycloak.failures.set(`PUT ${ADMIN}/users/user-1/execute-actions-email`, 500);
    const result = await adapter.createAccount(spec());
    expect(result.created).toBe(true);
    expect(result.notes.some((note) => note.includes("could not send the setup email (500)"))).toBe(true);
  });

  it("takes the username from the full email", async () => {
    const adapter = adapterFor(keycloak, { username_source: "email" });
    const result = await adapter.createAccount(spec({ email: "Ada@Example.invalid" }));
    expect(keycloak.users.get(result.account.externalId)!.username).toBe("ada@example.invalid");
  });

  it("lists the accounts page by page and skips service accounts", async () => {
    for (let index = 0; index < 150; index += 1) {
      keycloak.addUser(`user${index}`, `user${index}@example.invalid`);
    }
    keycloak.addUser("service-account-iam", "", { serviceAccountClientLink: "iam" });
    const accounts = await adapterFor(keycloak).listAccounts();
    expect(accounts).toHaveLength(150);
    expect(accounts.every((account) => account.groups === null)).toBe(true);
    expect(keycloak.callsTo("GET", `${ADMIN}/users`)).toHaveLength(2);
  });

  it("renews the cached token once after 401", async () => {
    const adapter = adapterFor(keycloak);
    await adapter.listGroups();
    keycloak.failures.set(`GET ${ADMIN}/users/count`, 401);
    // The retry also gets 401: the second answer is reported, no loop.
    await raises(
      adapter["request"]("GET", `admin/realms/${REALM}/users/count`, "count users"),
      ConfigurationError,
    );
    expect(keycloak.tokenCalls).toBe(2);
  });

  it("refuses dot segments", async () => {
    await raises(adapterFor(keycloak).findAccount(spec(), ".."), AdapterError);
  });

  it("mentions the console in manual instructions", () => {
    const adapter = adapterFor(keycloak);
    const text = adapter.manualInstructions("ensure_account", spec(), ["/apps/wiki"]);
    expect(text).toContain("Keycloak admin console");
    expect(text).toContain("/apps/wiki");
    expect(adapter.manualInstructions("disable_account", spec(), [])).toContain("turn Enabled off");
  });

  it("needs an explicit opt-in for plain HTTP", () => {
    const settings = {
      base_url: "http://keycloak:8080",
      realm: "example",
      client_id: "iam",
      client_secret: "secret",
    };
    const plain = new KeycloakAdapter(settings);
    expect(() => plain["checkConfig"]()).toThrow(ConfigurationError);
    expect(() => plain["checkConfig"]()).toThrow(/HTTPS/);
    new KeycloakAdapter({ ...settings, allow_http: true })["checkConfig"]();
  });

  it("never changes a username of someone with another email", async () => {
    const other = keycloak.addUser("ada", "ada.byron@example.invalid", { enabled: false });
    await raises(
      adapterFor(keycloak).ensureAccount(spec(), {
        groups: new Set(["g-wiki"]),
        managedGroups: new Set(["g-wiki"]),
      }),
      AdapterError,
      /different email/,
    );
    await raises(
      adapterFor(keycloak).disableAccount(spec(), { managedGroups: new Set() }),
      AdapterError,
      /different email/,
    );
    expect(keycloak.callsTo("PUT", `/users/${other}`)).toEqual([]);
    expect(keycloak.memberships.get(other)).toEqual(new Set());
  });

  it("takes a managed default group from a new user", async () => {
    keycloak.defaultGroups = new Set(["g-sales"]);
    const result = await adapterFor(keycloak).ensureAccount(spec(), {
      groups: new Set(["g-wiki"]),
      managedGroups: new Set(["g-wiki", "g-sales"]),
    });
    expect(keycloak.memberships.get(result.account.externalId)).toEqual(new Set(["g-wiki"]));
    expect(result.groupsRemoved).toEqual(["g-sales"]);
  });

  it("runs a failed logout again with the job", async () => {
    const userId = keycloak.addUser("ada", "ada@example.invalid");
    keycloak.failures.set(`POST ${ADMIN}/users/${userId}/logout`, 503);
    await raises(adapterFor(keycloak).disableAccount(spec(), { managedGroups: new Set() }), TransientError);
    expect(keycloak.users.get(userId)!.enabled).toBe(false);
    keycloak.failures.delete(`POST ${ADMIN}/users/${userId}/logout`);
    const result = await adapterFor(keycloak).disableAccount(spec(), { managedGroups: new Set() });
    expect(result.changed).toBe(false);
    expect(keycloak.callsTo("POST", `/users/${userId}/logout`)).toHaveLength(2);
  });

  it("turns a setup email that times out into a credentials problem", async () => {
    const handler: Handler = (request) =>
      request.url.pathname.endsWith("/execute-actions-email") ? timeoutError() : keycloak.handle(request);
    const adapter = new KeycloakAdapter(
      { base_url: BASE, realm: REALM, client_id: "iam", client_secret: "s" },
      { fetch: mockFetch(checked(handler)) },
    );
    const result = await adapter.ensureAccount(spec(), { groups: new Set(), managedGroups: new Set() });
    expect(result.created).toBe(true);
    expect(result.credentialsProblem).toContain("could not send the setup email (no answer)");
  });

  it("turns a refused temporary password into a credentials problem", async () => {
    keycloak.failures.set(`PUT ${ADMIN}/users/user-1/reset-password`, 400);
    const result = await adapterFor(keycloak, {
      send_setup_email: false,
      set_temporary_password: true,
    }).ensureAccount(spec(), { groups: new Set(), managedGroups: new Set() });
    expect(result.initialPassword).toBeNull();
    expect(result.credentialsProblem).toContain("did not set a temporary password (400)");
  });

  it("hands out the sign-in unless both ways are off", () => {
    expect(adapterFor(keycloak).handsOutSignIn()).toBe(true);
    expect(
      adapterFor(keycloak, { send_setup_email: false, set_temporary_password: true }).handsOutSignIn(),
    ).toBe(true);
    expect(
      adapterFor(keycloak, { send_setup_email: false, set_temporary_password: false }).handsOutSignIn(),
    ).toBe(false);
  });

  // -- rehearsals predict the job ------------------------------------------------

  function writes(fake: FakeKeycloak): Call[] {
    return fake.calls.filter((call) => call[0] !== "GET" && call[1] !== TOKEN_PATH);
  }

  it("names the name update in a rehearsal", async () => {
    keycloak.addUser("ada", "ada@example.invalid", { enabled: false, lastName: "Byron" });
    const adapter = adapterFor(keycloak);
    const plan = await rehearse(adapter, "ensure_account", spec());
    expect([plan.change, plan.also]).toEqual(["reactivate", ["update the name"]]);
    expect(writes(keycloak)).toEqual([]);
    const result = await adapter.ensureAccount(spec(), { groups: new Set(), managedGroups: new Set() });
    expect(result.reactivated).toBe(true);
    expect(result.notes).toContain("Updated the name in Keycloak.");
  });

  it("changes nothing in a rehearsal of a current user", async () => {
    keycloak.addUser("ada", "ada@example.invalid");
    const plan = await rehearse(adapterFor(keycloak), "ensure_account", spec());
    expect([plan.change, plan.also]).toEqual(["keep", []]);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("names the logout in a rehearsal of offboarding (enabled %s, logout %s)", async (enabled, logout) => {
    keycloak.addUser("ada", "ada@example.invalid", { enabled });
    const adapter = adapterFor(keycloak, { logout_on_disable: logout });
    const plan = await rehearse(adapter, "disable_account", spec());
    expect(plan.change).toBe(enabled ? "disable" : "already disabled");
    expect(plan.also).toEqual(logout ? ["end the user's sessions"] : []);
    expect(writes(keycloak)).toEqual([]);
    await adapter.disableAccount(spec(), { managedGroups: new Set() });
    expect(keycloak.callsTo("POST", "/logout").length > 0).toBe(logout);
  });

  it("counts the realm's default groups in a rehearsal", async () => {
    // Keycloak puts a new user in the realm's default groups; the job then
    // removes the managed ones the person should not have.
    keycloak.defaultGroups = new Set(["g-sales", "g-wiki"]);
    const adapter = adapterFor(keycloak);
    const groups = new Set(["g-wiki", "g-apps"]);
    const managed = new Set(["g-wiki", "g-apps", "g-sales"]);
    const plan = await rehearse(adapter, "ensure_account", spec(), { groups, managedGroups: managed });
    expect([plan.change, plan.groupsToAdd, plan.groupsToRemove]).toEqual(["create", ["g-apps"], ["g-sales"]]);
    expect(writes(keycloak)).toEqual([]);
    const result = await adapter.ensureAccount(spec(), { groups, managedGroups: managed });
    expect(result.created).toBe(true);
    expect([result.groupsAdded, result.groupsRemoved]).toEqual([["g-apps"], ["g-sales"]]);
  });
});
