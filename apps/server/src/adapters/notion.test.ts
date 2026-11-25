import { afterEach, describe, expect, it } from "vitest";
import { AdapterError, ConfigurationError, TransientError, accountSpec, type AccountSpec } from "./base";
import { NOTION_VERSION, NotionAdapter } from "./notion";
import { answer, json, mockFetch, type Handler, type MockFetch } from "../test/mock-fetch";

const TOKEN = "ntn_test_token_value";

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
    email: "Ada@example.invalid",
    ...overrides,
  });
}

function person(userId: string, email: string, name = "Someone") {
  return { object: "user", id: userId, type: "person", name, person: { email } };
}

function bot(userId: string) {
  return { object: "user", id: userId, type: "bot", name: "Integration", bot: {} };
}

function adapter(fetch: MockFetch, config: Record<string, unknown> = {}) {
  return new NotionAdapter({ token: TOKEN, ...config }, { fetch });
}

function paged(pages: Record<string, unknown>): Handler {
  return (request) => {
    expect(request.url.pathname).toBe("/v1/users");
    expect(request.url.searchParams.get("page_size")).toBe("100");
    return json(200, pages[request.url.searchParams.get("start_cursor") ?? ""]);
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

describe("Notion", () => {
  it("names the workspace when it connects", async () => {
    const fetch = transport(() => json(200, { type: "bot", bot: { workspace_name: "Example" } }));
    const result = await adapter(fetch).testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Example");
    const request = fetch.requests[0]!;
    expect(request.url.pathname).toBe("/v1/users/me");
    expect(request.headers.get("notion-version")).toBe(NOTION_VERSION);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("makes everything manual without a token", async () => {
    const notion = new NotionAdapter({});
    expect(notion.canReadAccounts()).toBe(false);
    const result = await notion.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("No token");
    const error = await failure(notion.findAccount(spec()));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toMatch(/needs a token/);
    expect(await failure(notion.listAccounts())).toBeInstanceOf(ConfigurationError);
  });

  it("takes an invalid token for a configuration error", async () => {
    const fetch = transport(() => json(401, { message: "API token is invalid." }));
    const error = await failure(adapter(fetch).testConnection());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).not.toContain(TOKEN);
  });

  it("takes a rate limit for a passing failure", async () => {
    const fetch = transport(() => answer(429));
    expect(await failure(adapter(fetch).listAccounts())).toBeInstanceOf(TransientError);
  });

  it("lists the accounts page by page and skips bots", async () => {
    const pages = {
      "": {
        results: [person("u1", "ada@example.invalid"), bot("b1")],
        has_more: true,
        next_cursor: "c2",
      },
      c2: { results: [person("u2", "")], has_more: false, next_cursor: null },
    };
    const accounts = await adapter(transport(paged(pages))).listAccounts();
    expect(accounts.map((account) => account.externalId)).toEqual(["u1", "u2"]);
    expect(accounts[0]!.email).toBe("ada@example.invalid");
    expect(accounts.every((account) => account.active)).toBe(true);
  });

  it("takes more pages without a cursor for an error", async () => {
    const pages = { "": { results: [], has_more: true, next_cursor: null } };
    const error = await failure(adapter(transport(paged(pages))).listAccounts());
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/inconsistent/);
  });

  it("matches the email regardless of case", async () => {
    const pages = {
      "": {
        results: [bot("b1"), person("u1", "other@example.invalid")],
        has_more: true,
        next_cursor: "c2",
      },
      c2: { results: [person("u2", "ada@example.invalid", "Ada")], has_more: false },
    };
    const account = (await adapter(transport(paged(pages))).findAccount(spec()))!;
    expect(account.externalId).toBe("u2");
    expect(account.displayName).toBe("Ada");
  });

  it("finds no account", async () => {
    const pages = { "": { results: [person("u1", "other@example.invalid")], has_more: false } };
    expect(await adapter(transport(paged(pages))).findAccount(spec())).toBeNull();
  });

  it("is uncertain about an account while emails are hidden", async () => {
    const pages = { "": { results: [person("u1", "")], has_more: false } };
    const error = await failure(adapter(transport(paged(pages))).findAccount(spec()));
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/hides the email/);
  });

  it("finds an account by external ID", async () => {
    const fetch = transport((request) => {
      expect(request.url.pathname).toBe("/v1/users/u7");
      return json(200, person("u7", "ada@example.invalid"));
    });
    const account = (await adapter(fetch).findAccount(spec(), "u7"))!;
    expect(account.externalId).toBe("u7");
    expect(fetch.requests).toHaveLength(1);
  });

  it("falls back to the email for an unknown external ID", async () => {
    const fetch = transport((request) => {
      if (request.url.pathname === "/v1/users/gone") return json(404, { object: "error" });
      return json(200, { results: [person("u3", "ada@example.invalid")], has_more: false });
    });
    const account = (await adapter(fetch).findAccount(spec(), "gone"))!;
    expect(account.externalId).toBe("u3");
  });

  it("takes a server error at a user lookup for a passing failure", async () => {
    const fetch = transport(() => answer(503));
    expect(await failure(adapter(fetch).findAccount(spec(), "u1"))).toBeInstanceOf(TransientError);
  });

  it("writes manual instructions", () => {
    const notion = new NotionAdapter({ workspace_url: "https://www.notion.so/example" });
    const invite = notion.manualInstructions("ensure_account", spec(), []);
    expect(invite).toContain("Invite");
    expect(invite).toContain("Ada@example.invalid");
    expect(invite).toContain("https://www.notion.so/example");
    expect(invite).toContain("cannot read Notion");
    const remove = new NotionAdapter({ token: TOKEN }).manualInstructions("disable_account", spec(), []);
    expect(remove).toContain("Remove");
    expect(remove).not.toContain("cannot read");
  });

  it("states its capabilities", () => {
    expect(NotionAdapter.supportsWrite).toBe(false);
    expect(NotionAdapter.supportsGroups).toBe(false);
    expect(NotionAdapter.fields.filter((spec) => spec.kind === "secret").map((spec) => spec.name)).toEqual([
      "token",
    ]);
  });
});
