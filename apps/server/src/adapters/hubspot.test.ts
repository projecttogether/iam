import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterError,
  TransientError,
  accountSpec,
  readOnly,
  type AccountSpec,
  type Adapter,
  type JobActionName,
} from "./base";
import { HubSpotAdapter, USERS_PATH } from "./hubspot";
import { answer, json, mockFetch, type Handler, type MockFetch, type SeenRequest } from "../test/mock-fetch";

const TOKEN = "hubspot-test-token-value";

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

function spec(overrides: Partial<AccountSpec> = {}): AccountSpec {
  return accountSpec({
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada",
    email: "ada@example.invalid",
    ...overrides,
  });
}

function adapter(fetch: MockFetch, config: Record<string, unknown> = {}) {
  return new HubSpotAdapter({ access_token: TOKEN, ...config }, { fetch });
}

function hsUser(
  options: { id?: string; primary?: string | null; secondary?: string[] } = {},
  extra: Record<string, unknown> = {},
) {
  return {
    id: options.id ?? "11",
    email: "ada@example.invalid",
    firstName: "Ada",
    lastName: "Lovelace",
    primaryTeamId: options.primary ?? null,
    secondaryTeamIds: [...(options.secondary ?? [])],
    ...extra,
  };
}

/** The path as sent, percent-encoding included. */
function rawPath(request: SeenRequest): string {
  return request.url.pathname;
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
  hubspot: Adapter,
  action: JobActionName,
  person: AccountSpec,
  options: { externalId?: string; groups?: string[]; managedGroups?: string[] } = {},
) {
  const reader = readOnly(hubspot);
  const found = await reader.findAccount(person, options.externalId ?? "");
  return reader.plan(action, person, {
    found,
    groups: new Set(options.groups ?? []),
    managedGroups: new Set(options.managedGroups ?? []),
  });
}

describe("HubSpot", () => {
  it("connects", async () => {
    const handler: Handler = (request) => {
      expect(request.url.host).toBe("api.hubapi.com");
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (request.url.pathname === USERS_PATH) {
        expect(request.url.searchParams.get("limit")).toBe("1");
        return json(200, { results: [] });
      }
      expect(request.url.pathname).toBe(`${USERS_PATH}/teams`);
      return json(200, { results: [] });
    };
    expect((await adapter(transport(handler)).testConnection()).ok).toBe(true);
  });

  it("reports a refused connection", async () => {
    const fetch = transport(() => answer(403, `bad ${TOKEN}`));
    const result = await adapter(fetch).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("403");
    expect(result.message).not.toContain(TOKEN);
  });

  it("finds a user by ID, then by email", async () => {
    const handler: Handler = (request) => {
      if (request.url.pathname === `${USERS_PATH}/99`) return answer(404);
      if (rawPath(request) === `${USERS_PATH}/ada%40example.invalid`) {
        expect(request.url.searchParams.get("idProperty")).toBe("EMAIL");
        return json(200, hsUser({ primary: "t1", secondary: ["t2"] }));
      }
      throw new Error(String(request.url));
    };
    const account = (await adapter(transport(handler)).findAccount(spec(), "99"))!;
    expect(account.externalId).toBe("11");
    expect(account.email).toBe("ada@example.invalid");
    expect(account.groups).toEqual(new Set(["t1", "t2"]));
    expect(account.active).toBe(true);
  });

  it("needs a working users route to call a user missing", async () => {
    const handler: Handler = (request) => {
      if (request.url.pathname === USERS_PATH) return json(200, { results: [] });
      return answer(404);
    };
    expect(await adapter(transport(handler)).findAccount(spec())).toBeNull();
  });

  it("takes a missing users route for an error", async () => {
    const fetch = transport(() => answer(404));
    const error = await failure(adapter(fetch).findAccount(spec()));
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/version/);
  });

  it("invites a user and sets the teams", async () => {
    const state: { user: ReturnType<typeof hsUser> | null } = { user: null };
    const handler: Handler = (request) => {
      const path = request.url.pathname;
      if (request.method === "GET" && rawPath(request) === `${USERS_PATH}/ada%40example.invalid`) {
        return answer(404);
      }
      if (request.method === "GET" && path === USERS_PATH) return json(200, { results: [] });
      if (request.method === "POST") {
        expect(request.json()).toEqual({
          email: "ada@example.invalid",
          firstName: "Ada",
          lastName: "Lovelace",
          sendWelcomeEmail: false,
          roleId: "555",
        });
        state.user = hsUser();
        return json(201, state.user);
      }
      if (request.method === "GET" && path === `${USERS_PATH}/11`) return json(200, state.user);
      if (request.method === "PUT") {
        const payload = request.json();
        state.user = hsUser({ primary: payload.primaryTeamId, secondary: payload.secondaryTeamIds });
        return json(200, state.user);
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const fetch = transport(handler);
    const result = await adapter(fetch, { role_id: "555", send_welcome_email: false }).ensureAccount(spec(), {
      groups: new Set(["t1", "t2"]),
      managedGroups: new Set(["t1", "t2"]),
    });
    expect(result.created).toBe(true);
    expect(result.groupsAdded).toEqual(["t1", "t2"]);
    const puts = fetch.requests
      .filter((request) => request.method === "PUT")
      .map((request) => request.json());
    expect(puts).toEqual([
      { primaryTeamId: "t1", secondaryTeamIds: [] },
      { primaryTeamId: "t1", secondaryTeamIds: ["t2"] },
    ]);
    expect(result.account.groups).toEqual(new Set(["t1", "t2"]));
  });

  it("promotes a secondary team when the primary one is removed", async () => {
    const state = { user: hsUser({ primary: "t1", secondary: ["t2", "t3"] }) };
    const handler: Handler = (request) => {
      if (request.method === "GET") return json(200, state.user);
      const payload = request.json();
      state.user = hsUser({ primary: payload.primaryTeamId, secondary: payload.secondaryTeamIds });
      return json(200, state.user);
    };
    const fetch = transport(handler);
    const result = await adapter(fetch).ensureAccount(spec(), {
      externalId: "11",
      groups: new Set(["t2", "t3"]),
      managedGroups: new Set(["t1", "t2", "t3"]),
    });
    expect(result.groupsRemoved).toEqual(["t1"]);
    expect(
      fetch.requests
        .filter((request) => request.method === "PUT")
        .at(-1)!
        .json(),
    ).toEqual({
      primaryTeamId: "t2",
      secondaryTeamIds: ["t3"],
    });
  });

  it("uses the existing user when the invite conflicts", async () => {
    let lookups = 0;
    const handler: Handler = (request) => {
      if (request.method === "GET" && rawPath(request).includes("ada%40")) {
        lookups += 1;
        if (lookups === 1) return answer(404);
        return json(200, hsUser());
      }
      if (request.method === "GET") return json(200, { results: [] });
      if (request.method === "POST") return answer(409);
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const result = await adapter(transport(handler)).ensureAccount(spec(), {
      groups: new Set(),
      managedGroups: new Set(),
    });
    expect(result.created).toBe(false);
    expect(result.account.externalId).toBe("11");
  });

  it("removes the user to disable it", async () => {
    const handler: Handler = (request) => {
      if (request.method === "GET") return json(200, hsUser({ primary: "t1" }));
      expect(request.method).toBe("DELETE");
      expect(request.url.pathname).toBe(`${USERS_PATH}/11`);
      return answer(204);
    };
    const fetch = transport(handler);
    const result = await adapter(fetch).disableAccount(spec(), {
      externalId: "11",
      managedGroups: new Set(["t1"]),
    });
    expect(result.changed).toBe(true);
    expect(result.account!.active).toBe(false);
    expect(fetch.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("cannot reactivate a deactivated user through the API", async () => {
    const fetch = transport(() => json(200, hsUser({}, { deactivated: true })));
    const error = await failure(
      adapter(fetch).ensureAccount(spec(), { externalId: "11", groups: new Set(), managedGroups: new Set() }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/Reactivate/);
  });

  it("takes a server error for a passing failure", async () => {
    const fetch = transport(() => answer(502));
    expect(await failure(adapter(fetch).findAccount(spec(), "11"))).toBeInstanceOf(TransientError);
  });

  it("lists accounts and teams", async () => {
    const handler: Handler = (request) => {
      if (request.url.pathname === `${USERS_PATH}/teams`) {
        return json(200, { results: [{ id: 7, name: "Sales" }] });
      }
      if (request.url.searchParams.get("after") === "c2")
        return json(200, { results: [hsUser({ id: "12" })] });
      return json(200, { results: [hsUser({ id: "11" })], paging: { next: { after: "c2" } } });
    };
    const hubspot = adapter(transport(handler));
    expect((await hubspot.listAccounts()).map((account) => account.externalId)).toEqual(["11", "12"]);
    const groups = await hubspot.listGroups();
    expect(groups.map((group) => [group.externalId, group.name])).toEqual([["7", "Sales"]]);
  });

  it("takes a listing that is not JSON for an error", async () => {
    const handler: Handler = () => answer(200, "<html>Maintenance</html>");
    const accounts = await failure(adapter(transport(handler)).listAccounts());
    expect(accounts).toBeInstanceOf(AdapterError);
    expect(accounts.message).toMatch(/unreadable/);
    const groups = await failure(adapter(transport(handler)).listGroups());
    expect(groups).toBeInstanceOf(AdapterError);
    expect(groups.message).toMatch(/unreadable/);
  });

  it("takes a listing with entries that are no objects for an error", async () => {
    const handler: Handler = () => json(200, { results: [null] });
    const accounts = await failure(adapter(transport(handler)).listAccounts());
    expect(accounts).toBeInstanceOf(AdapterError);
    expect(accounts.message).toMatch(/unexpected/);
    const groups = await failure(adapter(transport(handler)).listGroups());
    expect(groups).toBeInstanceOf(AdapterError);
    expect(groups.message).toMatch(/unexpected/);
  });
});

// -- rehearsals predict the job ---------------------------------------------------

describe("HubSpot rehearsals", () => {
  it("of offboarding say the user is deleted", async () => {
    const handler: Handler = (request) => {
      if (request.method === "GET") return json(200, hsUser({ primary: "t1" }));
      return answer(204);
    };
    const fetch = transport(handler);
    const hubspot = adapter(fetch);
    const plan = await rehearse(hubspot, "disable_account", spec(), { externalId: "11" });
    expect(plan.change).toBe("delete");
    expect(new Set(fetch.requests.map((request) => request.method))).toEqual(new Set(["GET"]));
    expect(
      (await hubspot.disableAccount(spec(), { externalId: "11", managedGroups: new Set() })).changed,
    ).toBe(true);
    expect(fetch.requests.at(-1)!.method).toBe("DELETE");
  });

  it("refuse to reactivate a deactivated user", async () => {
    const fetch = transport(() => json(200, hsUser({}, { deactivated: true })));
    const hubspot = adapter(fetch);
    const plan = await rehearse(hubspot, "ensure_account", spec(), { externalId: "11" });
    expect(plan.change).toBe("reactivate");
    expect(plan.refusal.startsWith("HubSpot cannot reactivate a user through its API.")).toBe(true);
    const error = await failure(
      hubspot.ensureAccount(spec(), { externalId: "11", groups: new Set(), managedGroups: new Set() }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(plan.refusal);
    expect(new Set(fetch.requests.map((request) => request.method))).toEqual(new Set(["GET"]));
  });

  it("refuse a create without a work email", async () => {
    const fetch = transport(() => json(200, { results: [] }));
    const hubspot = adapter(fetch);
    const plan = await rehearse(hubspot, "ensure_account", spec({ email: "" }));
    expect([plan.change, plan.refusal]).toEqual(["create", "HubSpot accounts need a work email."]);
    const error = await failure(
      hubspot.ensureAccount(spec({ email: "" }), { groups: new Set(), managedGroups: new Set() }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(plan.refusal);
  });
});
