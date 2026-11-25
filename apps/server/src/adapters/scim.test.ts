import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { answer, json, mockFetch, type Handler, type MockFetch, type SeenRequest } from "../test/mock-fetch";
import {
  AdapterError,
  TransientError,
  accountSpec,
  externalAccount,
  readOnly,
  type AccountPlan,
  type AccountSpec,
  type Adapter,
  type JobActionName,
} from "./base";
import { ScimAdapter } from "./scim";

const BASE = "https://app.example.invalid/scim/v2";
const TOKEN = "scim-test-token-value";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SCIM resources are built and read loosely, as in Python
type Loose = Record<string, any>;

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

/** A fake transport that answers from `handler` and records the requests. */
function transportFor(handler: Handler): MockFetch {
  return mockFetch(checked(handler));
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

function adapter(transport: MockFetch, settings: Record<string, unknown> = {}): ScimAdapter {
  return new ScimAdapter({ base_url: BASE, token: TOKEN, ...settings }, { fetch: transport });
}

function user(
  uid = "u1",
  {
    active = true,
    groups = null,
    userName = "ada@example.invalid",
  }: {
    active?: boolean;
    groups?: string[] | null;
    userName?: string;
  } = {},
): Loose {
  const resource: Loose = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: uid,
    userName,
    displayName: "Ada Lovelace",
    emails: [{ value: "ada@example.invalid", primary: true }],
    active,
  };
  if (groups !== null) resource.groups = groups.map((group) => ({ value: group }));
  return resource;
}

function listing(resources: Loose[] = [], total?: number): Loose {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: total ?? resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  };
}

function body(request: SeenRequest): Loose {
  return request.json();
}

function param(request: SeenRequest, name: string): string {
  const value = request.url.searchParams.get(name);
  if (value === null) throw new Error(`No query parameter ${name}`);
  return value;
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

/**
 * What the job would do, read through the read-only wrapper as read-only
 * mode does: a step that changes anything throws ReadOnlyError.
 */
async function rehearse(
  scim: Adapter,
  action: JobActionName,
  person: AccountSpec,
  options: { externalId?: string; groups?: Iterable<string>; managedGroups?: Iterable<string> } = {},
): Promise<AccountPlan> {
  const reader = readOnly(scim);
  const found = await reader.findAccount(person, options.externalId ?? "");
  return reader.plan(action, person, {
    found,
    groups: new Set(options.groups ?? []),
    managedGroups: new Set(options.managedGroups ?? []),
  });
}

function someoneElses(userName: string): string {
  return (
    `The SCIM 2.0 app username ${userName} belongs to a user with a different email. Nothing was ` +
    "changed. Check the person's username and work email."
  );
}

describe("the SCIM adapter", () => {
  beforeEach(() => {
    handlerErrors = [];
  });

  afterEach(() => {
    if (handlerErrors.length > 0) throw handlerErrors[0];
  });

  it("tests the connection with the bearer token", async () => {
    const transport = transportFor((request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (request.url.pathname.endsWith("/ServiceProviderConfig")) {
        return json(200, { patch: { supported: true } });
      }
      expect(request.url.pathname).toBe("/scim/v2/Users");
      expect(param(request, "count")).toBe("1");
      return json(200, listing());
    });
    const result = await adapter(transport).testConnection();
    expect(result.ok).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });

  it("reports a refused connection without the secret", async () => {
    const transport = transportFor((request) => {
      if (request.url.pathname.endsWith("/ServiceProviderConfig")) return json(200, {});
      return answer(403, `denied for ${TOKEN}`);
    });
    const result = await adapter(transport).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("403");
    expect(result.message).not.toContain(TOKEN);
  });

  it("connects without a service provider configuration", async () => {
    const transport = transportFor((request) => {
      if (request.url.pathname.endsWith("/ServiceProviderConfig")) return answer(404);
      return json(200, listing());
    });
    expect((await adapter(transport).testConnection()).ok).toBe(true);
  });

  it("escapes quotes in the user name filter", async () => {
    const transport = transportFor((request) => {
      expect(request.url.pathname).toBe("/scim/v2/Users");
      expect(param(request, "filter")).toBe('userName eq "o\\"brien@example.invalid"');
      const found = user("u1", { groups: ["g1", "g2"], userName: 'o"brien@example.invalid' });
      found.emails = [{ value: 'o"brien@example.invalid', primary: true }];
      return json(200, listing([found]));
    });
    const account = await adapter(transport).findAccount(spec({ email: 'o"brien@example.invalid' }));
    expect(account!.externalId).toBe("u1");
    expect(account!.email).toBe('o"brien@example.invalid');
    expect(account!.active).toBe(true);
    expect(account!.groups).toEqual(new Set(["g1", "g2"]));
  });

  it("finds by the external ID first", async () => {
    const transport = transportFor((request) => {
      expect(request.url.pathname).toBe("/scim/v2/Users/u9");
      return json(200, user("u9", { active: false }));
    });
    const account = await adapter(transport).findAccount(spec(), "u9");
    expect(account!.externalId).toBe("u9");
    expect(account!.active).toBe(false);
    expect(account!.groups).toBeNull();
  });

  it("ignores an unsupported email filter", async () => {
    const transport = transportFor((request) => {
      if (request.url.pathname === "/scim/v2/Users/gone") return answer(404);
      const filter = param(request, "filter");
      if (filter.startsWith("userName")) {
        expect(filter).toBe('userName eq "ada"');
        return json(200, listing());
      }
      expect(filter).toBe('emails.value eq "ada@example.invalid"');
      return json(400, { detail: "unsupported filter" });
    });
    const found = await adapter(transport, { user_name_source: "username" }).findAccount(spec(), "gone");
    expect(found).toBeNull();
  });

  it("creates a user and adds the groups", async () => {
    const transport = transportFor((request) => {
      if (request.method === "GET" && request.url.pathname === "/scim/v2/Users") return json(200, listing());
      if (request.method === "POST") {
        const payload = body(request);
        expect(payload.userName).toBe("ada@example.invalid");
        expect(payload.name).toEqual({ givenName: "Ada", familyName: "Lovelace" });
        expect(payload.emails).toEqual([{ value: "ada@example.invalid", primary: true, type: "work" }]);
        expect(payload.active).toBe(true);
        expect(request.headers.get("content-type")).toBe("application/scim+json");
        return json(201, user("new"));
      }
      if (request.method === "GET" && request.url.pathname === "/scim/v2/Groups") {
        expect(param(request, "filter")).toBe('members.value eq "new"');
        return json(200, listing([{ id: "old", displayName: "Old" }]));
      }
      if (request.method === "PATCH") return answer(204);
      throw new Error(`Unexpected request: ${request.method} ${request.url.href}`);
    });
    const result = await adapter(transport).ensureAccount(spec(), {
      groups: new Set(["g1"]),
      managedGroups: new Set(["g1", "old"]),
    });
    expect(result.created).toBe(true);
    expect(result.account.externalId).toBe("new");
    expect(result.groupsAdded).toEqual(["g1"]);
    expect(result.groupsRemoved).toEqual(["old"]);
    const patches = transport.requests.filter((request) => request.method === "PATCH");
    expect(patches[0]!.url.pathname).toBe("/scim/v2/Groups/g1");
    expect(body(patches[0]!).Operations).toEqual([{ op: "add", path: "members", value: [{ value: "new" }] }]);
    expect(patches[1]!.url.pathname).toBe("/scim/v2/Groups/old");
    expect(body(patches[1]!).Operations).toEqual([{ op: "remove", path: 'members[value eq "new"]' }]);
  });

  it("finds the existing user on a create conflict", async () => {
    let searches = 0;
    const transport = transportFor((request) => {
      if (request.method === "GET") {
        searches += 1;
        if (searches === 1) return json(200, listing());
        return json(200, listing([user("existing", { groups: [] })]));
      }
      if (request.method === "POST") return json(409, { detail: "uniqueness" });
      throw new Error(`Unexpected request: ${request.method} ${request.url.href}`);
    });
    const result = await adapter(transport).ensureAccount(spec(), {
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(result.created).toBe(false);
    expect(result.account.externalId).toBe("existing");
  });

  it("deactivates and removes the managed groups when disabling", async () => {
    const transport = transportFor((request) => {
      if (request.method === "GET") return json(200, user("u1", { groups: ["g1", "unmanaged"] }));
      if (request.method === "PATCH" && request.url.pathname === "/scim/v2/Groups/g1") return answer(204);
      if (request.method === "PATCH" && request.url.pathname === "/scim/v2/Users/u1") {
        expect(body(request).Operations).toEqual([{ op: "replace", path: "active", value: false }]);
        return json(200, user("u1", { active: false }));
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url.href}`);
    });
    const result = await adapter(transport).disableAccount(spec(), {
      externalId: "u1",
      managedGroups: new Set(["g1"]),
    });
    expect(result.changed).toBe(true);
    expect(result.account!.active).toBe(false);
    expect(result.groupsRemoved).toEqual(["g1"]);
    expect(transport.requests.some((request) => request.url.pathname.endsWith("/unmanaged"))).toBe(false);
  });

  it("falls back to the value form to deactivate", async () => {
    const transport = transportFor((request) => {
      if (request.method === "GET") return json(200, user("u1"));
      const operations = body(request).Operations;
      if (operations[0].path === "active") return json(400, { detail: "path not supported" });
      expect(operations).toEqual([{ op: "replace", value: { active: false } }]);
      return answer(204);
    });
    const result = await adapter(transport, { groups_enabled: false }).disableAccount(spec(), {
      externalId: "u1",
      managedGroups: new Set(),
    });
    expect(result.changed).toBe(true);
    expect(result.account!.active).toBe(false);
  });

  it("deletes the user in delete mode", async () => {
    const transport = transportFor((request) => {
      if (request.method === "GET") return json(200, user("u1", { groups: [] }));
      expect(request.method).toBe("DELETE");
      expect(request.url.pathname).toBe("/scim/v2/Users/u1");
      return answer(204);
    });
    const result = await adapter(transport, { deactivate_mode: "delete" }).disableAccount(spec(), {
      externalId: "u1",
      managedGroups: new Set(),
    });
    expect(result.changed).toBe(true);
    expect(result.account!.active).toBe(false);
  });

  it("treats a server error as transient", async () => {
    const transport = transportFor(() => answer(503));
    await raises(adapter(transport).findAccount(spec()), TransientError);
  });

  it("treats a client error as permanent", async () => {
    const transport = transportFor(() => answer(422));
    const error = await raises(adapter(transport).findAccount(spec()), AdapterError);
    expect(error.retryable).toBe(false);
  });

  it("lists the groups page by page", async () => {
    const transport = transportFor((request) => {
      const start = Number(param(request, "startIndex"));
      expect(param(request, "attributes")).toBe("displayName");
      if (start === 1) {
        const page = Array.from({ length: 100 }, (_, index) => ({
          id: `g${index}`,
          displayName: `Group ${index}`,
        }));
        return json(200, listing(page, 101));
      }
      expect(start).toBe(101);
      return json(200, listing([{ id: "g100", displayName: "Last" }], 101));
    });
    const groups = await adapter(transport).listGroups();
    expect(groups).toHaveLength(101);
    expect(groups.at(-1)!.name).toBe("Last");
  });

  it("skips the group calls when groups are off", async () => {
    const transport = transportFor((request) => {
      if (request.method === "GET") return json(200, listing([user("u1")]));
      throw new Error(`Unexpected request: ${request.method} ${request.url.href}`);
    });
    const scim = adapter(transport, { groups_enabled: false });
    expect(await scim.listGroups()).toEqual([]);
    const result = await scim.ensureAccount(spec(), {
      groups: new Set(["g1"]),
      managedGroups: new Set(["g1"]),
    });
    expect(result.groupsAdded).toEqual([]);
  });

  it("lists the accounts", async () => {
    const transport = transportFor(() => json(200, listing([user("u1"), user("u2", { active: false })])));
    const accounts = await adapter(transport).listAccounts();
    expect(accounts.map((account) => account.externalId)).toEqual(["u1", "u2"]);
    expect(accounts.map((account) => account.active)).toEqual([true, false]);
  });

  it("matches nobody when the server ignores the filter", async () => {
    const stranger = user("u7", { userName: "grace@example.invalid" });
    stranger.emails = [{ value: "grace@example.invalid" }];
    const transport = transportFor(() => json(200, listing([stranger])));
    expect(await adapter(transport).findAccount(spec())).toBeNull();
  });

  it("refuses two users with the email", async () => {
    const transport = transportFor((request) => {
      if (param(request, "filter").startsWith("userName")) return json(200, listing());
      return json(200, listing([user("u1", { userName: "ada" }), user("u2", { userName: "ada2" })]));
    });
    await raises(adapter(transport).findAccount(spec()), AdapterError, /Several/);
  });

  it("finds a user with another user name by the email", async () => {
    const transport = transportFor((request) => {
      if (param(request, "filter").startsWith("userName")) return json(200, listing());
      expect(param(request, "filter")).toBe('emails.value eq "ada@example.invalid"');
      return json(200, listing([user("u3", { userName: "old.name" })]));
    });
    const found = await adapter(transport).findAccount(spec());
    expect(found!.externalId).toBe("u3");
  });

  it("treats a listing that is no list response as an error", async () => {
    const handler: Handler = () => answer(200, "<html>Maintenance</html>");
    await raises(adapter(transportFor(handler)).listAccounts(), AdapterError, /unreadable/);
    await raises(adapter(transportFor(handler)).listGroups(), AdapterError, /unreadable/);
  });

  it("reads the group memberships from every page", async () => {
    const transport = transportFor((request) => {
      expect(param(request, "filter")).toBe('members.value eq "u1"');
      const start = Number(param(request, "startIndex"));
      const page = [];
      for (let index = start; index < Math.min(start + 100, 151); index += 1) page.push({ id: `g${index}` });
      return json(200, listing(page, 150));
    });
    const groups = await adapter(transport).accountGroups(externalAccount("u1"));
    expect(groups.size).toBe(150);
    expect(groups.has("g150")).toBe(true);
  });

  it("treats unreadable group memberships as an error", async () => {
    const transport = transportFor(() => json(400, { detail: "unsupported filter" }));
    await raises(
      adapter(transport).accountGroups(externalAccount("u1")),
      AdapterError,
      /cannot list a user's groups/,
    );
  });

  it("treats a listing with entries that are no objects as an error", async () => {
    const transport = transportFor(() => json(200, { Resources: [null], totalResults: 1 }));
    await raises(adapter(transport).listAccounts(), AdapterError, /unexpected/);
  });

  it.each(["username", "email"])(
    "never changes a user name of someone with another email (%s)",
    async (source) => {
      // As at Keycloak: a userName can belong to someone else (another J. Smith),
      // and an email that is not the person's shows it does.
      const userName = source === "username" ? "ada" : "ada@example.invalid";
      const other = user("u7", { active: false, userName });
      other.emails = [{ value: "ada.byron@example.invalid", primary: true }];
      const transport = transportFor((request) => {
        expect(request.method).toBe("GET");
        if (param(request, "filter").startsWith("userName")) return json(200, listing([other]));
        return json(200, listing());
      });
      const scim = adapter(transport, { user_name_source: source });
      let error = await raises(
        scim.ensureAccount(spec(), { groups: new Set(["g1"]), managedGroups: new Set(["g1"]) }),
        AdapterError,
      );
      expect(error.message).toBe(someoneElses(userName));
      error = await raises(scim.disableAccount(spec(), { managedGroups: new Set(["g1"]) }), AdapterError);
      expect(error.message).toBe(someoneElses(userName));
    },
  );

  it("never takes over someone else's user name on a create conflict", async () => {
    const other = user("u7", { active: false, userName: "ada" });
    other.emails = [{ value: "ada.byron@example.invalid" }];
    const found: Record<string, Loose> = { userName: listing(), "emails.value": listing() };
    const transport = transportFor((request) => {
      if (request.method === "POST") {
        // Created meanwhile, e.g. by someone in the app.
        found.userName = listing([other]);
        return json(409, { detail: "uniqueness" });
      }
      expect(request.method).toBe("GET");
      return json(200, found[param(request, "filter").split(" ")[0]!]);
    });
    const error = await raises(
      adapter(transport, { user_name_source: "username" }).ensureAccount(spec(), {
        groups: new Set(),
        managedGroups: new Set(),
      }),
      AdapterError,
    );
    expect(error.message).toBe(someoneElses("ada"));
    expect(
      transport.requests.filter((request) => request.method !== "GET").map((request) => request.method),
    ).toEqual(["POST"]);
  });

  it("takes a user name match with the person's email, or none, as theirs", async () => {
    const mine = user("u1", { userName: "ada" });
    mine.emails = [{ value: "ada.private@example.invalid", primary: true }, { value: "ADA@example.invalid" }];
    const without = user("u2", { userName: "ada" });
    delete without.emails;

    for (const resource of [mine, without]) {
      const transport = transportFor(() => json(200, listing([resource])));
      const found = await adapter(transport, { user_name_source: "username" }).findAccount(spec());
      expect(found!.externalId).toBe(resource.id);
    }
  });

  // -- rehearsals predict the job ------------------------------------------------

  it.each([
    ["delete", "delete"],
    ["active_false", "disable"],
  ])("says in a rehearsal of offboarding whether the user is deleted (%s)", async (mode, change) => {
    const transport = transportFor((request) => {
      if (request.method === "GET") return json(200, user("u1", { groups: [] }));
      if (request.method === "DELETE") return answer(204);
      return json(200, user("u1", { active: false, groups: [] }));
    });
    const scim = adapter(transport, { deactivate_mode: mode });
    const plan = await rehearse(scim, "disable_account", spec(), { externalId: "u1" });
    expect(plan.change).toBe(change);
    expect(new Set(transport.requests.map((request) => request.method))).toEqual(new Set(["GET"]));
    await scim.disableAccount(spec(), { externalId: "u1", managedGroups: new Set() });
    expect(transport.requests.at(-1)!.method).toBe(mode === "delete" ? "DELETE" : "PATCH");
  });

  it("does not take a redirect for an answer", async () => {
    // A base URL that moved, or a sign-in page in front of the API: no call
    // reaches SCIM, so nothing connects and nothing counts as disabled.
    const transport = transportFor(() => answer(302, "", { location: "https://app.example.invalid/login" }));
    const scim = adapter(transport);
    const known = externalAccount("u1", { username: "ada@example.invalid", groups: new Set() });
    await raises(scim.disableAccount(spec(), { managedGroups: new Set(), found: known }), AdapterError);
    expect((await scim.testConnection()).ok).toBe(false);
  });

  it("does not take a page that is no user for the user it reads by ID", async () => {
    // A maintenance or sign-in page answers 200 to every request.
    const transport = transportFor(() => answer(200, "<html>Back soon</html>"));
    const scim = adapter(transport);
    await raises(scim.findAccount(spec(), "u1"), AdapterError);
    expect(transport.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("refuses a create without a user name in a rehearsal", async () => {
    const transport = transportFor(() => json(200, listing()));
    const scim = adapter(transport);
    const nameless = spec({ username: "", email: "" });
    const plan = await rehearse(scim, "ensure_account", nameless);
    expect([plan.change, plan.refusal]).toEqual(["create", "SCIM accounts need a work email or username."]);
    const error = await raises(
      scim.ensureAccount(nameless, { groups: new Set(), managedGroups: new Set() }),
      AdapterError,
    );
    expect(error.message).toBe(plan.refusal);
  });
});
