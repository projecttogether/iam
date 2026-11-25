import { beforeEach, describe, expect, it } from "vitest";
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
import { RelutionAdapter, USERS_PATH, updatePayload } from "./relution";
import { answer, json, mockFetch, type Handler, type SeenRequest } from "../test/mock-fetch";

const ORG = "org-1";
const CONFIG = {
  base_url: "https://relution.example.invalid",
  organization_uuid: ORG,
  api_token: "relution-test-token",
};
const SPEC = accountSpec({
  firstName: "Ada",
  lastName: "Lovelace",
  username: "ada",
  email: "Ada@Example.invalid",
});

type User = Record<string, unknown>;

/** In-memory Relution: users, groups and the per-user membership resource. */
class FakeRelution {
  users = new Map<string, User>();
  groups = new Map<string, User>([
    ["g-1", { uuid: "g-1", name: "Staff devices", organizationUuid: ORG }],
    ["g-2", { uuid: "g-2", name: "Laptops", organizationUuid: ORG }],
    ["g-x", { uuid: "g-x", name: "Other org", organizationUuid: "org-2" }],
  ]);
  members = new Map<string, Set<string>>();
  failWith: number | null = null;
  writes: [string, string][] = [];

  addUser(uuid: string, email: string, options: { activated?: boolean; org?: string } & User = {}) {
    const { activated = true, org = ORG, ...extra } = options;
    this.users.set(uuid, {
      uuid,
      organizationUuid: org,
      name: email,
      email,
      givenName: "Ada",
      surname: "Lovelace",
      activated,
      locked: false,
      ssoOnly: true,
      ...extra,
    });
    this.members.set(uuid, new Set());
  }

  user(uuid: string): User {
    return this.users.get(uuid)!;
  }

  handle = (request: SeenRequest): Response => {
    expect.soft(request.headers.get("X-User-Access-Token")).toBe("relution-test-token");
    if (this.failWith) return json(this.failWith, { error: "secret detail" });
    const path = request.url.pathname;
    const method = request.method;
    if (method !== "GET") this.writes.push([method, path]);
    if (path === USERS_PATH && method === "GET") return this.page([...this.users.values()], request);
    if (path === "/api/management/v1/security/groups" && method === "GET") {
      return this.page([...this.groups.values()], request);
    }
    if (path === USERS_PATH && method === "POST") {
      const body = request.json();
      expect.soft(body.organizationUuid).toBe(ORG);
      const uuid = `u-${this.users.size + 1}`;
      this.users.set(uuid, { uuid, ...body, locked: false });
      this.members.set(uuid, new Set());
      return json(201, this.users.get(uuid));
    }
    const prefix = `${USERS_PATH}/`;
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      const [uuid = "", sub = ""] = rest.split(/\/(.*)/s);
      if (!this.users.has(uuid)) return json(404, {});
      if (sub === "groups" && method === "GET") {
        return json(200, { groups: [...this.members.get(uuid)!].sort().map((group) => ({ uuid: group })) });
      }
      if (sub === "groups" && method === "PUT") {
        const body = request.json();
        expect.soft(Array.isArray(body)).toBe(true);
        this.members.set(uuid, new Set(body as string[]));
        return answer(204);
      }
      if (method === "GET") return json(200, this.users.get(uuid));
      if (method === "PUT") {
        const body = request.json() as User;
        expect.soft(Object.keys(body).some((key) => key.toLowerCase().includes("password"))).toBe(false);
        this.users.set(uuid, body);
        return json(200, body);
      }
    }
    return answer(405);
  };

  page(items: User[], request: SeenRequest): Response {
    const limit = Number(request.url.searchParams.get("limit"));
    const offset = Number(request.url.searchParams.get("offset"));
    return json(200, { items: items.slice(offset, offset + limit) });
  }
}

/**
 * What the job would do (an AccountPlan), read through the read-only
 * wrapper: a step that changes anything throws ReadOnlyError.
 */
async function rehearse(
  adapter: Adapter,
  action: JobActionName,
  spec: AccountSpec,
  options: { externalId?: string; groups?: string[]; managedGroups?: string[] } = {},
) {
  const reader = readOnly(adapter);
  const found = await reader.findAccount(spec, options.externalId ?? "");
  return reader.plan(action, spec, {
    found,
    groups: new Set(options.groups ?? []),
    managedGroups: new Set(options.managedGroups ?? []),
  });
}

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("The promise did not fail");
}

function relution(handler: Handler, config: Record<string, unknown> = CONFIG) {
  return new RelutionAdapter(config, { fetch: mockFetch(handler) });
}

describe("Relution", () => {
  let fake: FakeRelution;
  let adapter: RelutionAdapter;
  beforeEach(() => {
    fake = new FakeRelution();
    adapter = relution(fake.handle);
  });

  it("tests the connection", async () => {
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
  });

  it("hides the body of an unauthorized answer", async () => {
    fake.failWith = 401;
    const error = await failure(adapter.testConnection());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).not.toContain("secret detail");
    expect(error.message).not.toContain("relution-test-token");
  });

  it("treats a server error as transient", async () => {
    fake.failWith = 503;
    await expect(adapter.listGroups()).rejects.toBeInstanceOf(TransientError);
  });

  it("rejects an address with a path or plain HTTP", async () => {
    for (const url of ["https://relution.example.invalid/api", "http://relution.example.invalid"]) {
      const bad = relution(fake.handle, { ...CONFIG, base_url: url });
      await expect(bad.testConnection()).rejects.toBeInstanceOf(ConfigurationError);
    }
  });

  it("reports a missing token as a configuration error", async () => {
    const bad = relution(fake.handle, { ...CONFIG, api_token: "" });
    await expect(bad.testConnection()).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("lists groups and ignores other organizations", async () => {
    const groups = await adapter.listGroups();
    expect(groups.map((group) => group.externalId)).toEqual(["g-1", "g-2"]);
    expect(groups[0]!.name).toBe("Staff devices");
  });

  it("creates an account with groups", async () => {
    const result = await adapter.ensureAccount(SPEC, {
      groups: new Set(["g-1"]),
      managedGroups: new Set(["g-1", "g-2"]),
    });
    expect(result.created).toBe(true);
    expect(result.groupsAdded).toEqual(["g-1"]);
    const user = fake.user(result.account.externalId);
    expect(user.email).toBe("ada@example.invalid");
    expect(user.managedAppleId).toBe("ada@example.invalid");
    expect(user.ssoOnly).toBe(true);
    expect(fake.members.get(result.account.externalId)).toEqual(new Set(["g-1"]));
    expect(result.initialPassword).toBeNull();
  });

  it("does not create an account without a work email", async () => {
    const spec = accountSpec({ firstName: "Ada", lastName: "Lovelace", username: "ada" });
    await expect(adapter.createAccount(spec)).rejects.toBeInstanceOf(AdapterError);
  });

  it("finds an account by ID, then by email", async () => {
    fake.addUser("u-9", "ada@example.invalid");
    const byId = await adapter.findAccount(SPEC, "u-9");
    expect(byId!.externalId).toBe("u-9");
    // A stale ID falls back to the work email.
    const byEmail = await adapter.findAccount(SPEC, "gone");
    expect(byEmail!.externalId).toBe("u-9");
    const nobody = accountSpec({
      firstName: "X",
      lastName: "Y",
      username: "nobody",
      email: "x@example.invalid",
    });
    expect(await adapter.findAccount(nobody)).toBeNull();
  });

  it("finds no account in other organizations", async () => {
    fake.addUser("u-other", "ada@example.invalid", { org: "org-2" });
    expect(await adapter.findAccount(SPEC)).toBeNull();
  });

  it("refuses duplicate matches", async () => {
    fake.addUser("u-1", "ada@example.invalid");
    fake.addUser("u-2", "ADA@example.invalid");
    await expect(adapter.findAccount(SPEC)).rejects.toBeInstanceOf(AdapterError);
  });

  it("reactivates an existing account and reconciles the managed groups", async () => {
    fake.addUser("u-1", "ada@example.invalid", { activated: false });
    fake.members.set("u-1", new Set(["g-2", "unmanaged"]));
    const result = await adapter.ensureAccount(SPEC, {
      externalId: "u-1",
      groups: new Set(["g-1"]),
      managedGroups: new Set(["g-1", "g-2"]),
    });
    expect(result.created).toBe(false);
    expect(result.reactivated).toBe(true);
    expect(result.groupsAdded).toEqual(["g-1"]);
    expect(result.groupsRemoved).toEqual(["g-2"]);
    expect(fake.user("u-1").activated).toBe(true);
    expect(fake.members.get("u-1")).toEqual(new Set(["g-1", "unmanaged"]));
  });

  it("does not report a locked user as active", async () => {
    fake.addUser("u-1", "ada@example.invalid", { activated: false, locked: true });
    const keepLocked = (request: SeenRequest) => {
      const response = fake.handle(request);
      fake.user("u-1").locked = true;
      return response;
    };
    const locked = relution(keepLocked);
    const error = await failure(
      locked.ensureAccount(SPEC, { externalId: "u-1", groups: new Set(), managedGroups: new Set() }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toMatch(/locked/);
  });

  it("deactivates on disable without deleting and keeps the groups", async () => {
    fake.addUser("u-1", "ada@example.invalid", { password: "hash" });
    fake.members.set("u-1", new Set(["g-1"]));
    const result = await adapter.disableAccount(SPEC, { externalId: "u-1", managedGroups: new Set(["g-1"]) });
    expect(result.changed).toBe(true);
    expect(result.account!.active).toBe(false);
    expect(fake.user("u-1").activated).toBe(false);
    expect(fake.user("u-1")).not.toHaveProperty("password");
    expect(fake.members.get("u-1")).toEqual(new Set(["g-1"]));
    expect(fake.writes.some(([method]) => method === "DELETE")).toBe(false);
  });

  it("does nothing to disable a missing account", async () => {
    const result = await adapter.disableAccount(SPEC, { managedGroups: new Set() });
    expect(result.account).toBeNull();
    expect(result.changed).toBe(false);
  });

  it("writes nothing to disable an account that is already inactive", async () => {
    fake.addUser("u-1", "ada@example.invalid", { activated: false });
    const result = await adapter.disableAccount(SPEC, { externalId: "u-1", managedGroups: new Set() });
    expect(result.changed).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("pages through the accounts", async () => {
    for (let index = 0; index < 205; index += 1) {
      fake.addUser(`u-${index}`, `user${index}@example.invalid`, { activated: index % 2 === 0 });
    }
    const accounts = await adapter.listAccounts();
    expect(accounts).toHaveLength(205);
    expect(accounts[1]!.active).toBe(false);
    expect(accounts[0]!.groups).toBeNull();
  });

  it("reads before failing a create whose answer was lost", async () => {
    const flaky = (request: SeenRequest) => {
      if (request.method === "POST") {
        fake.handle(request); // stored, but the answer is lost
        return answer(504);
      }
      return fake.handle(request);
    };
    const result = await relution(flaky).createAccount(SPEC);
    expect(result.created).toBe(true);
    expect(fake.users.size).toBe(1);
  });

  it("drops credentials from an update", () => {
    const body = updatePayload(
      { uuid: "u", passwordHash: "x", apiToken: "y", name: "n" },
      { activated: false },
    );
    expect(body).toEqual({ uuid: "u", name: "n", activated: false });
  });

  it("never suggests a delete in manual instructions", () => {
    const text = adapter.manualInstructions("disable_account", SPEC, []);
    expect(text).toContain("deactivate");
    expect(text).toContain("Do not delete");
  });

  it("deactivates a locked user on offboarding", async () => {
    fake.addUser("u-1", "ada@example.invalid", { locked: true });
    const result = await adapter.disableAccount(SPEC, { externalId: "u-1", managedGroups: new Set() });
    expect(result.changed).toBe(true);
    expect(fake.user("u-1").activated).toBe(false);
  });

  it("does not take roles for group memberships", async () => {
    fake.addUser("u-1", "ada@example.invalid", { roles: [{ uuid: "role-admin" }] });
    fake.members.set("u-1", new Set(["g-2"]));
    const result = await adapter.ensureAccount(SPEC, {
      externalId: "u-1",
      groups: new Set(["g-1"]),
      managedGroups: new Set(["g-1", "g-2"]),
    });
    expect(fake.members.get("u-1")).toEqual(new Set(["g-1"]));
    expect(result.groupsRemoved).toEqual(["g-2"]);
  });

  const someoneElses = (name: string) =>
    `The Relution username ${name} belongs to a user with a different email. Nothing was ` +
    "changed. Check the person's username and work email.";

  /**
   * As at Keycloak: a login name can belong to someone else (another
   * J. Smith), and an email that is not the person's shows it does.
   */
  it.each(["ada", "ada@example.invalid"])(
    "never changes a username of someone with another email (%s)",
    async (name) => {
      fake.addUser("u-7", "ada.byron@example.invalid", { activated: false });
      fake.user("u-7").name = name;
      let error = await failure(
        adapter.ensureAccount(SPEC, { groups: new Set(["g-1"]), managedGroups: new Set(["g-1"]) }),
      );
      expect(error).toBeInstanceOf(AdapterError);
      expect(error.message).toBe(someoneElses(name));
      error = await failure(adapter.disableAccount(SPEC, { managedGroups: new Set(["g-1"]) }));
      expect(error).toBeInstanceOf(AdapterError);
      expect(error.message).toBe(someoneElses(name));
      expect(fake.writes).toEqual([]);
    },
  );

  it("never takes over someone else's username after a create whose answer was lost", async () => {
    const flaky = (request: SeenRequest) => {
      if (request.method === "POST") {
        // Someone else's user holds the login name meanwhile.
        fake.addUser("u-7", "ada.byron@example.invalid");
        fake.user("u-7").name = "ada@example.invalid";
        return answer(504);
      }
      return fake.handle(request);
    };
    const error = await failure(relution(flaky).createAccount(SPEC));
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(someoneElses("ada@example.invalid"));
  });

  it("takes a username match without an email as theirs", async () => {
    fake.addUser("u-1", "");
    fake.user("u-1").name = "ada";
    expect((await adapter.findAccount(SPEC))!.externalId).toBe("u-1");
  });

  // -- rehearsals predict the job ------------------------------------------------

  /**
   * A locked user counts as inactive but stays activated: unlocking it would
   * let the person in again, so offboarding deactivates it.
   */
  it("rehearses deactivating a locked user as offboarding does", async () => {
    fake.addUser("u-1", "ada@example.invalid", { locked: true });
    const plan = await rehearse(adapter, "disable_account", SPEC, { externalId: "u-1" });
    expect([plan.change, plan.refusal]).toEqual(["disable", ""]);
    expect(fake.writes).toEqual([]);
    const result = await adapter.disableAccount(SPEC, { externalId: "u-1", managedGroups: new Set() });
    expect(result.changed).toBe(true);
    expect(fake.user("u-1").activated).toBe(false);
  });

  it.each([true, false])("does not reactivate a locked user (activated: %s)", async (activated) => {
    fake.addUser("u-1", "ada@example.invalid", { activated, locked: true });
    const plan = await rehearse(adapter, "ensure_account", SPEC, { externalId: "u-1", groups: ["g-1"] });
    expect(plan.refusal).toBe(
      "The Relution user is locked. Nothing was changed. Unlock it in Relution, then run the job again.",
    );
    const error = await failure(
      adapter.ensureAccount(SPEC, {
        externalId: "u-1",
        groups: new Set(["g-1"]),
        managedGroups: new Set(["g-1"]),
      }),
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(plan.refusal);
    expect(fake.writes).toEqual([]);
  });

  it("rehearses refusing a create without a work email", async () => {
    const spec = accountSpec({ firstName: "Ada", lastName: "Lovelace", username: "ada" });
    const plan = await rehearse(adapter, "ensure_account", spec);
    expect([plan.change, plan.refusal]).toEqual([
      "create",
      "A Relution account needs the person's work email.",
    ]);
    const error = await failure(adapter.ensureAccount(spec, { groups: new Set(), managedGroups: new Set() }));
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe(plan.refusal);
  });

  it("rehearses the group changes of the job", async () => {
    fake.addUser("u-1", "ada@example.invalid", { activated: false });
    fake.members.set("u-1", new Set(["g-2", "unmanaged"]));
    const plan = await rehearse(adapter, "ensure_account", SPEC, {
      groups: ["g-1"],
      managedGroups: ["g-1", "g-2"],
    });
    expect([plan.change, plan.groupsToAdd, plan.groupsToRemove]).toEqual(["reactivate", ["g-1"], ["g-2"]]);
    expect(fake.writes).toEqual([]);
    const result = await adapter.ensureAccount(SPEC, {
      groups: new Set(["g-1"]),
      managedGroups: new Set(["g-1", "g-2"]),
    });
    expect(result.reactivated).toBe(true);
    expect([result.groupsAdded, result.groupsRemoved]).toEqual([["g-1"], ["g-2"]]);
  });
});
