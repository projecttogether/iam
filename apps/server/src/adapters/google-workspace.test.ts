import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterError,
  ConfigurationError,
  TransientError,
  accountSpec,
  readOnly,
  type AccountSpec,
  type Adapter,
  type JobActionName,
} from "./base";
import { GoogleWorkspaceAdapter, SCOPES } from "./google-workspace";
import {
  answer,
  answers,
  connectError,
  json,
  mockFetch,
  timeoutError,
  type Handler,
  type MockFetch,
  type SeenRequest,
} from "../test/mock-fetch";

const PREFIX = "/admin/directory/v1";

/**
 * Failures inside a handler (an assertion, an unexpected request) would
 * reach the adapter as a failed request; they fail the test here instead.
 */
const handlerFailures: unknown[] = [];
afterEach(() => {
  const failures = handlerFailures.splice(0);
  if (failures.length > 0) throw failures[0];
});

function transport(handler: Handler): MockFetch {
  return mockFetch(async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      handlerFailures.push(error);
      throw error;
    }
  });
}

/** The adapter with Google's sign-in replaced, as the Python tests patch `_access_token`. */
class SignedIn extends GoogleWorkspaceAdapter {
  protected override async accessToken(): Promise<string> {
    return "test-token";
  }
}

/** The adapter with its real sign-in in reach of the tests. */
class SignIn extends GoogleWorkspaceAdapter {
  signIn(): Promise<string> {
    return this.accessToken();
  }
}

function makeAdapter(fetch: MockFetch, config: Record<string, unknown> = {}) {
  return new SignedIn(
    {
      service_account_json: "{}",
      admin_email: "admin@example.invalid",
      domain: "example.invalid",
      ...config,
    },
    { fetch },
  );
}

function spec(overrides: Partial<AccountSpec> = {}): AccountSpec {
  return accountSpec({
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada",
    email: "ada@example.invalid",
    personalEmail: "ada.private@example.invalid",
    ...overrides,
  });
}

type GoogleUser = {
  id: string;
  primaryEmail: string;
  name: { fullName: string };
  suspended: boolean;
  isAdmin: boolean;
  isDelegatedAdmin: boolean;
};

function user(
  options: { id?: string; email?: string; suspended?: boolean; admin?: boolean } = {},
): GoogleUser {
  return {
    id: options.id ?? "u1",
    primaryEmail: options.email ?? "ada@example.invalid",
    name: { fullName: "Ada Lovelace" },
    suspended: options.suspended ?? false,
    isAdmin: options.admin ?? false,
    isDelegatedAdmin: false,
  };
}

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the promise to fail");
}

/**
 * What the job would do (an AccountPlan), read through the read-only
 * wrapper: a step that changes anything throws ReadOnlyError.
 */
async function rehearse(
  adapter: Adapter,
  action: JobActionName,
  person: AccountSpec,
  options: { externalId?: string; groups?: string[]; managedGroups?: string[] } = {},
) {
  const reader = readOnly(adapter);
  const found = await reader.findAccount(person, options.externalId ?? "");
  return reader.plan(action, person, {
    found,
    groups: new Set(options.groups ?? []),
    managedGroups: new Set(options.managedGroups ?? []),
  });
}

/** A small in-memory Directory API. */
class Directory {
  users: Record<string, GoogleUser>;
  /** Group ID -> IDs of the member users. */
  memberships: Record<string, Set<string>>;
  created: Record<string, unknown>[] = [];
  memberStatus: number | null = null;
  readonly handler: Handler = (request) => this.handle(request);

  constructor(users: GoogleUser[] = [], memberships: Record<string, Set<string>> = {}) {
    this.users = Object.fromEntries(users.map((entry) => [entry.id, entry]));
    this.memberships = memberships;
  }

  byKey(key: string): GoogleUser | undefined {
    return Object.values(this.users).find((entry) => key === entry.id || key === entry.primaryEmail);
  }

  handle(request: SeenRequest): Response {
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    const decoded = decodeURIComponent(request.url.pathname);
    const path = decoded.startsWith(PREFIX) ? decoded.slice(PREFIX.length) : decoded;
    const params = request.url.searchParams;
    const key = () => path.split("/").slice(2).join("/");
    if (request.method === "GET" && path === "/groups" && params.has("userKey")) {
      const id = params.get("userKey")!;
      const groups = Object.entries(this.memberships)
        .filter(([, members]) => members.has(id))
        .map(([group]) => ({ id: group }));
      return json(200, { groups });
    }
    if (request.method === "GET" && path.startsWith("/users/")) {
      const found = this.byKey(key());
      return found ? json(200, found) : json(404, {});
    }
    if (request.method === "POST" && path === "/users") {
      const body = request.json();
      if (this.byKey(body.primaryEmail)) return json(409, {});
      this.created.push(body);
      const created = user({ id: "new1", email: body.primaryEmail });
      this.users[created.id] = created;
      return json(200, created);
    }
    if (request.method === "PUT" && path.startsWith("/users/")) {
      const found = this.byKey(key())!;
      Object.assign(found, request.json());
      return json(200, found);
    }
    if (request.method === "POST" && path.endsWith("/members")) {
      if (this.memberStatus) return json(this.memberStatus, {});
      const group = path.split("/")[2]!;
      const email: string = request.json().email;
      (this.memberships[group] ??= new Set()).add(this.byKey(email)!.id);
      return json(200, {});
    }
    if (request.method === "DELETE" && path.includes("/members/")) {
      const [, , group, , member] = path.split("/") as [string, string, string, string, string];
      if (!this.memberships[group]?.has(member)) return json(404, {});
      this.memberships[group].delete(member);
      return answer(204);
    }
    throw new Error(`unexpected ${request.method} ${request.url}`);
  }
}

/** ada@ is an alias of Grace's account, as after Ada's account was deleted. */
class AliasDirectory extends Directory {
  override byKey(key: string): GoogleUser | undefined {
    if (key === "ada@example.invalid") return this.users.grace;
    return super.byKey(key);
  }
}

class Watched extends Directory {
  methods: string[] = [];

  override handle(request: SeenRequest): Response {
    this.methods.push(request.method);
    return super.handle(request);
  }
}

class WatchedAlias extends Watched {
  override byKey(key: string): GoogleUser | undefined {
    if (key === "ada@example.invalid") return this.users.grace;
    return super.byKey(key);
  }
}

// -- signing in -----------------------------------------------------------------

let keyPair: { publicKey: KeyObject; pem: string } | undefined;

/** An RSA key pair, made once: the private key as Google's JSON keys hold it. */
function rsaKey() {
  if (!keyPair) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPair = { publicKey, pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  }
  return keyPair;
}

function serviceAccountJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      type: "service_account",
      client_email: "iam@project.example.invalid",
      private_key_id: "key-1",
      private_key: rsaKey().pem,
      token_uri: "https://oauth2.example.invalid/token",
      ...extra,
    },
    null,
    2,
  );
}

type Assertion = { header: Record<string, unknown>; claims: Record<string, unknown>; signed: boolean };

/** The parts of a signed JWT, and whether the key's public half verifies it. */
function readAssertion(assertion: string): Assertion {
  const [header, claims, signature] = assertion.split(".") as [string, string, string];
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return {
    header: decode(header),
    claims: decode(claims),
    signed: verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      rsaKey().publicKey,
      Buffer.from(signature, "base64url"),
    ),
  };
}

/** A token endpoint at the key's token_uri that hands out `token`, and the assertions it saw. */
function tokenEndpoint(token: string, directory?: Handler) {
  const assertions: Assertion[] = [];
  const fetch = transport((request) => {
    if (request.url.href === "https://oauth2.example.invalid/token") {
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      const form = request.form();
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      assertions.push(readAssertion(form.get("assertion")!));
      return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }
    if (directory) return directory(request);
    throw new Error(`unexpected ${request.method} ${request.url}`);
  });
  return { fetch, assertions };
}

describe("Google Workspace", () => {
  it("connects", async () => {
    const fetch = transport(() => json(200, { users: [user()] }));
    const result = await makeAdapter(fetch).testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("example.invalid");
    const request = fetch.requests[0]!;
    expect(request.url.searchParams.get("customer")).toBe("my_customer");
    expect(request.url.searchParams.get("maxResults")).toBe("1");
  });

  it("takes an invalid key for a configuration error", async () => {
    const adapter = new GoogleWorkspaceAdapter(
      {
        service_account_json: "not json",
        admin_email: "admin@example.invalid",
        domain: "example.invalid",
      },
      {
        fetch: transport(() => {
          throw new Error("no request expected");
        }),
      },
    );
    const error = await failure(adapter.testConnection());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).not.toContain("not json");
  });

  it("takes missing settings for a configuration error", async () => {
    expect(await failure(new SignIn({}).signIn())).toBeInstanceOf(ConfigurationError);
  });

  it("follows the pages of the group listing", async () => {
    const pages: Record<string, unknown> = {
      "": {
        groups: [{ id: "g1", name: "Staff", email: "staff@example.invalid" }],
        nextPageToken: "p2",
      },
      p2: { groups: [{ id: "g2", email: "all@example.invalid", description: "All" }] },
    };
    const fetch = transport((request) => json(200, pages[request.url.searchParams.get("pageToken") ?? ""]));
    const groups = await makeAdapter(fetch).listGroups();
    expect(groups.map((group) => [group.externalId, group.name, group.path])).toEqual([
      ["g1", "Staff", "staff@example.invalid"],
      ["g2", "all@example.invalid", "all@example.invalid"],
    ]);
    expect(groups[1]!.description).toBe("All");
  });

  it("creates a user with a first password and the groups", async () => {
    const directory = new Directory();
    const adapter = makeAdapter(transport(directory.handler), { org_unit_path: "/Staff" });
    const result = await adapter.ensureAccount(spec(), {
      groups: new Set(["g1", "g2"]),
      managedGroups: new Set(["g1", "g2"]),
    });
    expect(result.created).toBe(true);
    expect(result.initialPassword).toBeTruthy();
    const body = directory.created[0]!;
    expect(body.password).toBe(result.initialPassword);
    expect(body.changePasswordAtNextLogin).toBe(true);
    expect(body.orgUnitPath).toBe("/Staff");
    expect(body.recoveryEmail).toBe("ada.private@example.invalid");
    expect(body.name).toEqual({ givenName: "Ada", familyName: "Lovelace" });
    expect([...result.groupsAdded].sort()).toEqual(["g1", "g2"]);
    expect(directory.memberships).toEqual({ g1: new Set(["new1"]), g2: new Set(["new1"]) });
  });

  it("returns no password when delivery is off", async () => {
    const directory = new Directory();
    const adapter = makeAdapter(transport(directory.handler), { deliver_initial_password: false });
    const result = await adapter.ensureAccount(spec(), { groups: new Set(), managedGroups: new Set() });
    expect(result.created).toBe(true);
    expect(result.initialPassword).toBeNull();
    expect(directory.created[0]!.password).toBeTruthy();
  });

  it("refuses an email outside the domain", async () => {
    const adapter = makeAdapter(transport(new Directory().handler));
    const error = await failure(
      adapter.ensureAccount(spec({ email: "ada@elsewhere.example.invalid" }), {
        groups: new Set(),
        managedGroups: new Set(),
      }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/example.invalid/);
  });

  it("accepts every configured domain", async () => {
    const directory = new Directory();
    const adapter = makeAdapter(transport(directory.handler), {
      domain: "example.invalid, @Extern.Example.invalid",
    });
    expect(adapter.domains).toEqual(["example.invalid", "extern.example.invalid"]);
    const result = await adapter.ensureAccount(spec({ email: "ada@extern.example.invalid" }), {
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(result.created).toBe(true);
    expect(directory.created[0]!.primaryEmail).toBe("ada@extern.example.invalid");
    const error = await failure(
      adapter.ensureAccount(spec({ email: "ada@elsewhere.example.invalid" }), {
        groups: new Set(),
        managedGroups: new Set(),
      }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/one of the domains example.invalid, extern/);
  });

  it("lets the service account act as itself without an admin user", async () => {
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const { fetch, assertions } = tokenEndpoint("token");
    expect(await new SignIn(config, { fetch }).signIn()).toBe("token");
    expect(assertions[0]!.claims.sub).toBeUndefined();
    await new SignIn({ ...config, admin_email: "admin@example.invalid" }, { fetch }).signIn();
    expect(assertions[1]!.claims.sub).toBe("admin@example.invalid");
  });

  it("signs in with an assertion the service account's key signed", async () => {
    const directory = new Directory([user()]);
    const { fetch, assertions } = tokenEndpoint("test-token", directory.handler);
    const google = new GoogleWorkspaceAdapter(
      {
        service_account_json: serviceAccountJson(),
        admin_email: "admin@example.invalid",
        domain: "example.invalid",
      },
      { fetch },
    );
    expect(await google.findAccount(spec(), "u1")).not.toBeNull();
    expect(await google.findAccount(spec())).not.toBeNull();
    // One sign-in per adapter; the Directory checked the token on each call.
    expect(assertions).toHaveLength(1);
    const { header, claims, signed } = assertions[0]!;
    expect(signed).toBe(true);
    expect(header).toEqual({ typ: "JWT", alg: "RS256", kid: "key-1" });
    expect(claims).toMatchObject({
      iss: "iam@project.example.invalid",
      sub: "admin@example.invalid",
      // google-auth signs for Google's token endpoint; the POST goes to the key's token_uri.
      aud: "https://oauth2.googleapis.com/token",
      scope: SCOPES.join(" "),
    });
    expect(claims.exp).toBe((claims.iat as number) + 3600);
    expect(Math.abs((claims.iat as number) - Date.now() / 1000)).toBeLessThan(60);
  });

  it("signs in at Google's token endpoint when the key names none", async () => {
    const fetch = transport((request) => {
      expect(request.url.href).toBe("https://oauth2.googleapis.com/token");
      expect(readAssertion(request.form().get("assertion")!).claims.aud).toBe(
        "https://oauth2.googleapis.com/token",
      );
      return json(200, { access_token: "token" });
    });
    const key = serviceAccountJson({ token_uri: undefined });
    const google = new SignIn({ service_account_json: key, domain: "example.invalid" }, { fetch });
    expect(await google.signIn()).toBe("token");
  });

  it("takes a refused sign-in for a configuration error", async () => {
    const fetch = transport(() => json(400, { error: "invalid_grant", error_description: "secret detail" }));
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const itself = await failure(new SignIn(config, { fetch }).signIn());
    expect(itself).toBeInstanceOf(ConfigurationError);
    expect(itself.message).toBe(
      "Google refused the service account. Check that its key is valid and not deleted.",
    );
    const delegated = await failure(
      new SignIn({ ...config, admin_email: "admin@example.invalid" }, { fetch }).signIn(),
    );
    expect(delegated).toBeInstanceOf(ConfigurationError);
    expect(delegated.message).toMatch(/domain-wide delegation/);
    expect(delegated.message).not.toContain("secret detail");
  });

  it("tries a busy token endpoint three times, as google-auth did", async () => {
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const recovering = transport(
      answers(
        answer(503),
        json(400, { error: "invalid_request", error_description: "temporarily_unavailable" }),
        json(200, { access_token: "token", expires_in: 3600 }),
      ),
    );
    expect(await new SignIn(config, { fetch: recovering }).signIn()).toBe("token");
    expect(recovering.requests).toHaveLength(3);
    const busy = transport(() => answer(503));
    expect(await failure(new SignIn(config, { fetch: busy }).signIn())).toBeInstanceOf(TransientError);
    expect(busy.requests).toHaveLength(3);
  });

  it.each([408, 429, 500, 503, 504])("tries the token exchange again after a %i", async (status) => {
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const fetch = transport(answers(answer(status), json(200, { access_token: "token", expires_in: 3600 })));
    expect(await new SignIn(config, { fetch }).signIn()).toBe("token");
    expect(fetch.requests).toHaveLength(2);
  });

  it("does not try a refusal again that only mentions a temporary error", async () => {
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const fetch = transport(() =>
      json(400, { error: "invalid_grant", error_description: "temporarily_unavailable: try again" }),
    );
    expect(await failure(new SignIn(config, { fetch }).signIn())).toBeInstanceOf(ConfigurationError);
    expect(fetch.requests).toHaveLength(1);
  });

  it("tries a gateway error once, like google-auth, and takes it for a passing failure", async () => {
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const fetch = transport(() => answer(502));
    expect(await failure(new SignIn(config, { fetch }).signIn())).toBeInstanceOf(TransientError);
    expect(fetch.requests).toHaveLength(1);
  });

  it.each([
    ["a refused connection", () => connectError()],
    ["a timeout", () => timeoutError()],
    ["a server error", () => answer(503)],
  ])("takes %s at sign-in for a passing failure", async (_, reply) => {
    const config = { service_account_json: serviceAccountJson(), domain: "example.invalid" };
    const error = await failure(new SignIn(config, { fetch: transport(reply) }).signIn());
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe("Could not reach Google to sign in the service account.");
  });

  it("looks the customer up once without an admin user", async () => {
    const fetch = transport((request) => {
      if (request.url.searchParams.get("domain")) return json(200, { users: [{ customerId: "C0abc" }] });
      return json(200, { users: [user()] });
    });
    const adapter = makeAdapter(fetch, {
      admin_email: "",
      domain: "example.invalid, extern.example.invalid",
    });
    expect((await adapter.testConnection()).ok).toBe(true);
    await adapter.listAccounts();
    const lookups = fetch.requests.filter((request) => request.url.searchParams.get("domain"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.url.searchParams.get("domain")).toBe("example.invalid");
    expect(lookups[0]!.url.searchParams.get("fields")).toBe("users(customerId)");
    const listings = fetch.requests.filter((request) => !request.url.searchParams.get("domain"));
    expect(listings.map((request) => request.url.searchParams.get("customer"))).toEqual(["C0abc", "C0abc"]);
  });

  it("needs no lookup with a configured customer ID", async () => {
    const fetch = transport(() => json(200, { users: [user()] }));
    const adapter = makeAdapter(fetch, { admin_email: "", customer_id: "C0xyz" });
    expect((await adapter.testConnection()).ok).toBe(true);
    expect(fetch.requests.map((request) => request.url.searchParams.get("customer"))).toEqual(["C0xyz"]);
  });

  it("takes an unknown customer for a configuration error", async () => {
    const adapter = makeAdapter(
      transport(() => json(200, {})),
      { admin_email: "" },
    );
    const error = await failure(adapter.testConnection());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toMatch(/customer ID/);
  });

  it("names the admin roles when access is refused without an admin user", async () => {
    const adapter = makeAdapter(
      transport(() => answer(403, "secret body")),
      { admin_email: "", customer_id: "C0xyz" },
    );
    const error = await failure(adapter.testConnection());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toMatch(/User Management Admin/);
    expect(error.message).not.toContain("secret body");
  });

  it("sets no password for a user that exists at the create", async () => {
    const directory = new Directory([user()]);
    const adapter = makeAdapter(transport(directory.handler));
    // The create conflicts with an account made after the app last looked
    // (e.g. a create whose response was lost); the adapter reads it instead.
    const result = await adapter.createAccount(spec());
    expect(result.created).toBe(false);
    expect(result.initialPassword).toBeNull();
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("reactivates a suspended user", async () => {
    const directory = new Directory([user({ suspended: true })]);
    const adapter = makeAdapter(transport(directory.handler));
    const result = await adapter.ensureAccount(spec(), {
      externalId: "u1",
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(result.reactivated).toBe(true);
    expect(result.created).toBe(false);
    expect(result.account.active).toBe(true);
    expect(directory.users.u1!.suspended).toBe(false);
  });

  it("does not reactivate a suspended admin", async () => {
    const directory = new Directory([user({ suspended: true, admin: true })]);
    const adapter = makeAdapter(transport(directory.handler));
    const error = await failure(
      adapter.ensureAccount(spec(), { externalId: "u1", groups: new Set(), managedGroups: new Set() }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/administrator/);
    expect(directory.users.u1!.suspended).toBe(true);
  });

  it("suspends and removes only the managed groups", async () => {
    const directory = new Directory([user()], {
      managed: new Set(["u1"]),
      unmanaged: new Set(["u1"]),
      other: new Set(),
    });
    const adapter = makeAdapter(transport(directory.handler));
    const result = await adapter.disableAccount(spec(), {
      externalId: "u1",
      managedGroups: new Set(["managed", "other"]),
    });
    expect(result.changed).toBe(true);
    expect(result.groupsRemoved).toEqual(["managed"]);
    expect(directory.memberships.unmanaged).toEqual(new Set(["u1"]));
    expect(directory.memberships.managed).toEqual(new Set());
    expect(directory.users.u1!.suspended).toBe(true);
    expect(result.account!.active).toBe(false);
  });

  it("suspends even when the groups cannot be read", async () => {
    const directory = new Directory([user()], { managed: new Set(["u1"]) });
    const handler: Handler = (request) => {
      if (request.url.pathname === `${PREFIX}/groups`) {
        // What Google answers when it cannot resolve the account's domain.
        return json(404, { error: { message: "Domain not found." } });
      }
      return directory.handle(request);
    };
    const adapter = makeAdapter(transport(handler));
    const result = await adapter.disableAccount(spec(), {
      externalId: "u1",
      managedGroups: new Set(["managed"]),
    });
    expect(result.changed).toBe(true);
    expect(directory.users.u1!.suspended).toBe(true);
    expect(result.groupError).toBeInstanceOf(AdapterError);
    expect(String(result.groupError?.message)).toContain("404");
    expect(result.groupsRemoved).toEqual([]);
  });

  it("does nothing to disable without an account", async () => {
    const adapter = makeAdapter(transport(new Directory().handler));
    const result = await adapter.disableAccount(spec(), { managedGroups: new Set(["g1"]) });
    expect(result.account).toBeNull();
    expect(result.changed).toBe(false);
  });

  it("does not suspend a super admin", async () => {
    const directory = new Directory([user({ admin: true })]);
    const adapter = makeAdapter(transport(directory.handler));
    const error = await failure(
      adapter.disableAccount(spec(), { externalId: "u1", managedGroups: new Set() }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/super admins/);
    expect(directory.users.u1!.suspended).toBe(false);
  });

  it("ignores the conflict of a member already in the group", async () => {
    const directory = new Directory([user()]);
    directory.memberStatus = 409;
    const adapter = makeAdapter(transport(directory.handler));
    const result = await adapter.ensureAccount(spec(), {
      externalId: "u1",
      groups: new Set(["g1"]),
      managedGroups: new Set(["g1"]),
    });
    expect(result.groupsAdded).toEqual(["g1"]);
  });

  it("takes a rate limit for a passing failure", async () => {
    const adapter = makeAdapter(transport(() => json(429, {})));
    expect(await failure(adapter.listGroups())).toBeInstanceOf(TransientError);
  });

  it("takes a refusal for a configuration error", async () => {
    const adapter = makeAdapter(transport(() => answer(403, "secret body")));
    const error = await failure(adapter.testConnection());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).not.toContain("secret body");
  });

  it("follows the pages of the account listing", async () => {
    const pages: Record<string, unknown> = {
      "": { users: [user({ id: "u1" })], nextPageToken: "n" },
      n: { users: [user({ id: "u2", email: "bob@example.invalid", suspended: true })] },
    };
    const fetch = transport((request) => json(200, pages[request.url.searchParams.get("pageToken") ?? ""]));
    const accounts = await makeAdapter(fetch).listAccounts();
    expect(
      accounts.map((account) => [account.externalId, account.email, account.active, account.groups]),
    ).toEqual([
      ["u1", "ada@example.invalid", true, null],
      ["u2", "bob@example.invalid", false, null],
    ]);
    expect(fetch.requests[0]!.url.searchParams.get("maxResults")).toBe("500");
  });

  it("does not take an alias of another user for the person's account", async () => {
    const directory = new AliasDirectory([user({ id: "grace", email: "grace@example.invalid" })]);
    const google = makeAdapter(transport(directory.handler));
    expect(await google.findAccount(spec())).toBeNull();
    const result = await google.disableAccount(spec(), { managedGroups: new Set(["g1"]) });
    expect(result.account).toBeNull();
    expect(directory.users.grace!.suspended).toBe(false);
  });

  it("refuses to create an address that is an alias", async () => {
    const directory = new AliasDirectory([user({ id: "grace", email: "grace@example.invalid" })]);
    const error = await failure(
      makeAdapter(transport(directory.handler)).ensureAccount(spec(), {
        groups: new Set(["g1"]),
        managedGroups: new Set(["g1"]),
      }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/alias of another Google Workspace user/);
    expect(directory.memberships).toEqual({});
  });

  it("takes rate limits answered with 403 for passing failures", async () => {
    const error = { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } };
    const fetch = transport(() => json(403, error));
    expect(await failure(makeAdapter(fetch).findAccount(spec(), "u1"))).toBeInstanceOf(TransientError);
  });

  it("keeps the password of a create whose answer was lost", async () => {
    const directory = new Directory();
    const handler: Handler = (request) => {
      if (request.method === "POST" && request.url.pathname.endsWith("/users")) {
        directory.handle(request);
        return timeoutError();
      }
      return directory.handle(request);
    };
    const result = await makeAdapter(transport(handler)).ensureAccount(spec(), {
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(result.created).toBe(true);
    expect(result.initialPassword).toBeTruthy();
    expect(directory.created[0]!.password).toBe(result.initialPassword);
  });

  it("hands out the sign-in unless the password is not delivered", () => {
    const fetch = transport(() => json(200, {}));
    expect(makeAdapter(fetch).handsOutSignIn()).toBe(true);
    expect(makeAdapter(fetch, { deliver_initial_password: false }).handsOutSignIn()).toBe(false);
  });
});

// -- rehearsals predict the job ---------------------------------------------------

describe("Google Workspace rehearsals", () => {
  it.each([
    {
      directory: () => new Watched([user({ admin: true })]),
      action: "disable_account" as const,
      person: spec(),
      refusal: "Google Workspace super admins are not suspended automatically.",
    },
    {
      directory: () => new Watched([user({ suspended: true, admin: true })]),
      action: "ensure_account" as const,
      person: spec(),
      refusal:
        "Suspended Google Workspace administrator accounts are not reactivated " +
        "automatically. Reactivate the account in the Google Admin console.",
    },
    {
      directory: () => new Watched(),
      action: "ensure_account" as const,
      person: spec({ email: "ada@elsewhere.example.invalid" }),
      refusal: "The work email must be in the domain example.invalid.",
    },
  ])("fail where the job fails ($action: $refusal)", async ({ directory: make, action, person, refusal }) => {
    const directory = make();
    const google = makeAdapter(transport(directory.handler));
    const plan = await rehearse(google, action, person, { groups: ["g1"], managedGroups: ["g1"] });
    expect(plan.refusal).toBe(refusal);
    expect(directory.methods.every((method) => method === "GET")).toBe(true);
    const error = await failure(
      action === "disable_account"
        ? google.disableAccount(person, { managedGroups: new Set(["g1"]) })
        : google.ensureAccount(person, { groups: new Set(["g1"]), managedGroups: new Set(["g1"]) }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(refusal);
    expect(directory.methods).not.toContain("PUT");
  });

  it("refuse to create an address that is an alias", async () => {
    const directory = new WatchedAlias([user({ id: "grace", email: "grace@example.invalid" })]);
    const google = makeAdapter(transport(directory.handler));
    const plan = await rehearse(google, "ensure_account", spec(), { groups: ["g1"], managedGroups: ["g1"] });
    expect(plan.change).toBe("create");
    expect(plan.refusal.startsWith("ada@example.invalid is an alias of another Google Workspace")).toBe(true);
    const error = await failure(
      google.ensureAccount(spec(), { groups: new Set(["g1"]), managedGroups: new Set(["g1"]) }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(plan.refusal);
    expect(new Set(directory.methods)).toEqual(new Set(["GET"]));
  });

  it("of offboarding a super admin list the groups removed first", async () => {
    // The job removes the managed groups, then stops at the suspension.
    const directory = new Watched([user({ admin: true })], { g1: new Set(["u1"]) });
    const google = makeAdapter(transport(directory.handler));
    const plan = await rehearse(google, "disable_account", spec(), { managedGroups: ["g1"] });
    expect(plan.refusal).toBe("Google Workspace super admins are not suspended automatically.");
    expect(plan.groupsToRemove).toEqual(["g1"]);
    expect(new Set(directory.methods)).toEqual(new Set(["GET"]));
    expect(await failure(google.disableAccount(spec(), { managedGroups: new Set(["g1"]) }))).toBeInstanceOf(
      AdapterError,
    );
    expect(directory.memberships.g1).toEqual(new Set());
  });

  it("keep the refusal when the groups are unreadable", async () => {
    // The job catches the group error and stops at the suspension.
    const directory = new Watched([user({ admin: true })], { g1: new Set(["u1"]) });
    const handler: Handler = (request) => {
      if (request.url.pathname === `${PREFIX}/groups`) {
        return json(404, { error: { message: "Domain not found." } });
      }
      return directory.handle(request);
    };
    const google = makeAdapter(transport(handler));
    const plan = await rehearse(google, "disable_account", spec(), { managedGroups: ["g1"] });
    expect(plan.refusal).toBe("Google Workspace super admins are not suspended automatically.");
    expect(plan.groupsToRemove).toBeNull();
    const error = await failure(google.disableAccount(spec(), { managedGroups: new Set(["g1"]) }));
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(plan.refusal);
  });
});
