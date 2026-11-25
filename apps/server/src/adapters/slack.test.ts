import { describe, expect, it } from "vitest";
import { AdapterError, ConfigurationError, TransientError, accountSpec, type AccountSpec } from "./base";
import { SlackAdapter } from "./slack";
import { answer, json, mockFetch, recordPauses, type MockFetch } from "../test/mock-fetch";

const TOKEN = "xoxb-test-token-value";

function spec(values: Partial<AccountSpec> = {}): AccountSpec {
  return accountSpec({
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada",
    email: "ada@example.invalid",
    ...values,
  });
}

function ok(data: Record<string, unknown> = {}): Response {
  return json(200, { ok: true, ...data });
}

function error(code: string): Response {
  return json(200, { ok: false, error: code });
}

function adapter(fetch: MockFetch, config: Record<string, unknown> = {}): SlackAdapter {
  return new SlackAdapter({ bot_token: TOKEN, ...config }, { fetch });
}

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught as Error;
  }
  throw new Error("The promise did not fail");
}

describe("Slack", () => {
  it("reports the workspace in the connection test", async () => {
    const fetch = mockFetch(() => ok({ team: "Example", team_id: "T1" }));
    const result = await adapter(fetch).testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Example");
    const request = fetch.requests[0]!;
    expect(request.url.pathname).toBe("/api/auth.test");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(String(request.url)).not.toContain(TOKEN);
  });

  it("makes everything manual without a token", async () => {
    const slack = new SlackAdapter({});
    expect(slack.canReadAccounts()).toBe(false);
    const result = await slack.testConnection();
    expect(result.ok && result.message.includes("No token")).toBe(true);
    const caught = await failure(slack.findAccount(spec()));
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught.message).toMatch(/needs a bot token/);
    await expect(slack.listAccounts()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(slack.listGroups()).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("treats invalid_auth as a configuration error without the token", async () => {
    const fetch = mockFetch(() => error("invalid_auth"));
    const caught = await failure(adapter(fetch).testConnection());
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught.message).toContain("invalid_auth");
    expect(caught.message).not.toContain(TOKEN);
  });

  it("treats ratelimited as transient", async () => {
    const fetch = mockFetch(() => error("ratelimited"));
    await expect(adapter(fetch).findAccount(spec())).rejects.toBeInstanceOf(TransientError);
  });

  it("treats HTTP 429 as transient", async () => {
    const fetch = mockFetch(() => answer(429));
    await expect(adapter(fetch).testConnection()).rejects.toBeInstanceOf(TransientError);
  });

  it("finds an account by email", async () => {
    const fetch = mockFetch((request) => {
      expect.soft(request.url.pathname).toBe("/api/users.lookupByEmail");
      expect.soft(request.url.searchParams.get("email")).toBe("ada@example.invalid");
      return ok({
        user: {
          id: "U1",
          name: "ada",
          deleted: false,
          profile: { email: "ada@example.invalid", real_name: "Ada Lovelace" },
        },
      });
    });
    const account = (await adapter(fetch).findAccount(spec()))!;
    expect(account.externalId).toBe("U1");
    expect(account.email).toBe("ada@example.invalid");
    expect(account.displayName).toBe("Ada Lovelace");
    expect(account.active).toBe(true);
    expect(account.groups).toBeNull();
  });

  it("finds no account for an unknown email", async () => {
    const fetch = mockFetch(() => error("users_not_found"));
    expect(await adapter(fetch).findAccount(spec())).toBeNull();
  });

  it("looks up the external ID first, then the email", async () => {
    const fetch = mockFetch((request) => {
      if (request.url.pathname === "/api/users.info") return error("user_not_found");
      return ok({ user: { id: "U2", deleted: true, profile: { email: "ada@example.invalid" } } });
    });
    const account = (await adapter(fetch).findAccount(spec(), "U9"))!;
    expect(fetch.requests.map((request) => request.url.pathname)).toEqual([
      "/api/users.info",
      "/api/users.lookupByEmail",
    ]);
    expect(account.externalId).toBe("U2");
    expect(account.active).toBe(false);
  });

  it("finds an account by external ID", async () => {
    const fetch = mockFetch(() => ok({ user: { id: "U9", name: "ada", profile: {} } }));
    const account = (await adapter(fetch).findAccount(spec({ email: "" }), "U9"))!;
    expect(account.externalId).toBe("U9");
    expect(fetch.requests).toHaveLength(1);
  });

  it("treats an unknown Slack error as an adapter error", async () => {
    const fetch = mockFetch(() => error("fatal_error"));
    const caught = await failure(adapter(fetch).findAccount(spec()));
    expect(caught).toBeInstanceOf(AdapterError);
    expect(caught.message).toMatch(/fatal_error/);
  });

  it("pages through the accounts and skips bots", async () => {
    const pages: Record<string, Record<string, unknown>> = {
      "": {
        members: [
          { id: "U1", name: "ada", profile: { email: "ada@example.invalid" } },
          { id: "B1", name: "bot", is_bot: true, profile: {} },
          { id: "USLACKBOT", name: "slackbot", profile: {} },
        ],
        response_metadata: { next_cursor: "page2" },
      },
      page2: {
        members: [
          { id: "U2", name: "old", deleted: true, profile: {} },
          { id: "A1", name: "app", is_app_user: true, profile: {} },
        ],
        response_metadata: { next_cursor: "" },
      },
    };
    const fetch = mockFetch((request) => {
      expect.soft(request.url.pathname).toBe("/api/users.list");
      return ok(pages[request.url.searchParams.get("cursor") ?? ""]);
    });
    const accounts = await adapter(fetch).listAccounts();
    expect(accounts.map((account) => account.externalId)).toEqual(["U1", "U2"]);
    expect(accounts[0]!.active && !accounts[1]!.active).toBe(true);
  });

  it("waits out a rate limit in the middle of a listing and goes on", async () => {
    const { pauses } = recordPauses();
    // Slack allows about 20 users.list pages a minute and answers 429 beyond that.
    const limited: string[] = [];
    const fetch = mockFetch((request) => {
      const cursor = request.url.searchParams.get("cursor") ?? "";
      if (cursor === "page2" && limited.length === 0) {
        limited.push(cursor);
        return answer(429, "", { "Retry-After": "3" });
      }
      const members = [{ id: `U-${cursor || "page1"}`, name: cursor || "ada", profile: {} }];
      return ok({ members, response_metadata: { next_cursor: cursor ? "" : "page2" } });
    });
    const accounts = await adapter(fetch).listAccounts();
    expect(accounts.map((account) => account.externalId)).toEqual(["U-page1", "U-page2"]);
    expect(pauses).toEqual([3]);
  });

  it("rejects a repeated cursor", async () => {
    const fetch = mockFetch(() => ok({ members: [], response_metadata: { next_cursor: "same" } }));
    const caught = await failure(adapter(fetch).listAccounts());
    expect(caught).toBeInstanceOf(AdapterError);
    expect(caught.message).toMatch(/repeated/);
  });

  it("pages through the channels", async () => {
    const pages: Record<string, Record<string, unknown>> = {
      "": {
        channels: [
          { id: "C1", name: "general", purpose: { value: "Everyone" } },
          { id: "C2", name: "old", is_archived: true },
        ],
        response_metadata: { next_cursor: "next" },
      },
      next: { channels: [{ id: "G1", name: "private" }], response_metadata: {} },
    };
    const fetch = mockFetch((request) => {
      expect.soft(request.url.pathname).toBe("/api/conversations.list");
      expect.soft(request.url.searchParams.get("types")).toBe("public_channel,private_channel");
      expect.soft(request.url.searchParams.get("exclude_archived")).toBe("true");
      return ok(pages[request.url.searchParams.get("cursor") ?? ""]);
    });
    const groups = await adapter(fetch).listGroups();
    expect(groups.map((group) => [group.externalId, group.name])).toEqual([
      ["C1", "#general"],
      ["G1", "#private"],
    ]);
    expect(groups[0]!.description).toBe("Everyone");
  });

  it("rejects an unexpected answer", async () => {
    const fetch = mockFetch(() => answer(200, "<html>"));
    const caught = await failure(adapter(fetch).testConnection());
    expect(caught).toBeInstanceOf(AdapterError);
    expect(caught.message).toMatch(/unexpected/);
  });

  it("names the channels and the role in manual instructions", () => {
    const slack = new SlackAdapter({ workspace_url: "https://example.slack.com" });
    const text = slack.manualInstructions("ensure_account", spec(), ["#general", "#team"]);
    expect(text).toContain("#general, #team");
    expect(text).toContain("full member");
    expect(text).toContain("https://example.slack.com");
    expect(text).toContain("cannot read Slack");

    const guest = slack.manualInstructions("ensure_account", spec({ personType: "external" }), []);
    expect(guest).toContain("guest");

    const disable = new SlackAdapter({ bot_token: TOKEN }).manualInstructions("disable_account", spec(), []);
    expect(disable).toContain("Deactivate");
    expect(disable).not.toContain("cannot read");
  });

  it("declares its capabilities", () => {
    expect(SlackAdapter.supportsWrite).toBe(false);
    expect(SlackAdapter.supportsGroups).toBe(true);
    expect(SlackAdapter.groupLabel).toBe("Channels");
    const secretFields = SlackAdapter.fields
      .filter((spec) => spec.kind === "secret")
      .map((spec) => spec.name);
    expect(secretFields).toEqual(["bot_token"]);
  });

  it("carries no token in the body or the URL", async () => {
    const fetch = mockFetch(() => ok({ team: "T" }));
    await adapter(fetch).testConnection();
    const request = fetch.requests[0]!;
    expect(String(request.url)).not.toContain(TOKEN);
    expect(request.body).not.toContain(TOKEN);
  });
});
