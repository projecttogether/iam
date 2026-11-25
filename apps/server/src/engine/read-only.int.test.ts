import { types } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Adapter,
  AdapterError,
  ReadOnlyError,
  type AccountSpec,
  type ExternalAccount,
} from "../adapters/base";
import type { FetchLike } from "../adapters/http";
import { USERS_PATH } from "../adapters/relution";
import { SmtpAdapter } from "../adapters/smtp";
import { config, overrideConfigForTests, resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import {
  accounts,
  appSettings,
  auditEvents,
  connections,
  jobs,
  people,
  tasks,
  workflows,
  type Connection,
  type Job,
} from "../db/schema";
import { FakeAdapter, STORE, type FakeAccount } from "../test/fake-adapter";
import { makePerson, makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";
import { answer, json, mockFetch, type SeenRequest } from "../test/mock-fetch";
import { buildAdapter, encryptSecrets } from "./connections";
import type * as ConnectionsModule from "./connections";
import { notifyTasks, sendEmail } from "./email";
import { claimNextJob, runJob } from "./jobs";
import { startWorkflow } from "./lifecycle";
import { loadSettings } from "./settings";
import { compareAccounts, importGroups } from "./sync";

/**
 * Port of tests/test_read_only.py. Read-only mode (READ_ONLY=1): the app
 * reads connected apps, changes nothing in them, sends no email, and
 * rehearses every job.
 */

/**
 * Python's relution fixture patches Connection.build_adapter to pass a
 * transport; here buildAdapter of ./connections passes a fetch.
 */
const hooks = vi.hoisted(() => ({ fetch: null as FetchLike | null }));
vi.mock("./connections", async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionsModule>();
  return {
    ...actual,
    buildAdapter: (connection: Connection, options: Parameters<typeof actual.buildAdapter>[1] = {}) =>
      actual.buildAdapter(connection, hooks.fetch ? { fetch: hooks.fetch, ...options } : options),
  };
});

async function runAll() {
  for (let job = await claimNextJob(); job !== null; job = await claimNextJob()) await runJob(job);
}

function addAccount(options: { active?: boolean; groups?: string[] } = {}): FakeAccount {
  STORE.accounts.set("u-ada", {
    username: "ada",
    email: "ada@example.invalid",
    active: options.active ?? true,
    groups: new Set(options.groups ?? []),
  });
  return structuredClone(STORE.accounts.get("u-ada")!);
}

async function jobOf(workflowId: number): Promise<Job> {
  const rows = await getDb().select().from(jobs).where(eq(jobs.workflowId, workflowId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function theJob(): Promise<Job> {
  const rows = await getDb().select().from(jobs);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function workflowStatus(id: number) {
  const [row] = await getDb()
    .select({ status: workflows.status })
    .from(workflows)
    .where(eq(workflows.id, id));
  return row!.status;
}

async function personStatus(id: number) {
  const [row] = await getDb().select({ status: people.status }).from(people).where(eq(people.id, id));
  return row!.status;
}

async function count(table: typeof tasks | typeof accounts): Promise<number> {
  return (await getDb().select().from(table)).length;
}

// -- the in-memory Relution of tests/adapters/test_relution.py (also in src/adapters/relution.test.ts) --

const ORG = "org-1";
const RELUTION_CONFIG = {
  base_url: "https://relution.example.invalid",
  organization_uuid: ORG,
  api_token: "relution-test-token",
};

type RelutionUser = Record<string, unknown>;

class FakeRelution {
  users = new Map<string, RelutionUser>();
  groups = new Map<string, RelutionUser>([
    ["g-1", { uuid: "g-1", name: "Staff devices", organizationUuid: ORG }],
    ["g-2", { uuid: "g-2", name: "Laptops", organizationUuid: ORG }],
    ["g-x", { uuid: "g-x", name: "Other org", organizationUuid: "org-2" }],
  ]);
  members = new Map<string, Set<string>>();
  writes: [string, string][] = [];

  addUser(uuid: string, email: string, extra: RelutionUser = {}) {
    this.users.set(uuid, {
      uuid,
      organizationUuid: ORG,
      name: email,
      email,
      givenName: "Ada",
      surname: "Lovelace",
      activated: true,
      locked: false,
      ssoOnly: true,
      ...extra,
    });
    this.members.set(uuid, new Set());
  }

  handle = (request: SeenRequest): Response => {
    expect.soft(request.headers.get("X-User-Access-Token")).toBe("relution-test-token");
    const path = request.url.pathname;
    const method = request.method;
    if (method !== "GET") this.writes.push([method, path]);
    if (path === USERS_PATH && method === "GET") return this.page([...this.users.values()], request);
    if (path === "/api/management/v1/security/groups" && method === "GET") {
      return this.page([...this.groups.values()], request);
    }
    if (path === USERS_PATH && method === "POST") {
      const body = request.json();
      const uuid = `u-${this.users.size + 1}`;
      this.users.set(uuid, { uuid, ...body, locked: false });
      this.members.set(uuid, new Set());
      return json(201, this.users.get(uuid));
    }
    const prefix = `${USERS_PATH}/`;
    if (path.startsWith(prefix)) {
      const [uuid = "", sub = ""] = path.slice(prefix.length).split(/\/(.*)/s);
      if (!this.users.has(uuid)) return json(404, {});
      if (sub === "groups" && method === "GET") {
        return json(200, { groups: [...this.members.get(uuid)!].sort().map((group) => ({ uuid: group })) });
      }
      if (sub === "groups" && method === "PUT") {
        this.members.set(uuid, new Set(request.json() as string[]));
        return answer(204);
      }
      if (method === "GET") return json(200, this.users.get(uuid));
      if (method === "PUT") {
        const body = request.json() as RelutionUser;
        this.users.set(uuid, body);
        return json(200, body);
      }
    }
    return answer(405);
  };

  page(items: RelutionUser[], request: SeenRequest): Response {
    const limit = Number(request.url.searchParams.get("limit"));
    const offset = Number(request.url.searchParams.get("offset"));
    return json(200, { items: items.slice(offset, offset + limit) });
  }
}

/** The connection, pointed at an in-memory Relution. */
async function relution(connection: Connection): Promise<FakeRelution> {
  const fake = new FakeRelution();
  const { api_token, ...settings } = RELUTION_CONFIG;
  await getDb()
    .update(connections)
    .set({ adapter: "relution", settings, secretData: encryptSecrets({ api_token }) })
    .where(eq(connections.id, connection.id));
  hooks.fetch = mockFetch(fake.handle);
  return fake;
}

describe("read-only mode", () => {
  useEngineFixtures();
  beforeEach(() => overrideConfigForTests({ READ_ONLY: true }));
  afterEach(() => {
    hooks.fetch = null;
    vi.restoreAllMocks();
  });

  it("rehearses onboarding and changes nothing", async () => {
    const { person } = await standardSetup();
    await getDb().update(people).set({ teamId: null }).where(eq(people.id, person.id));
    const before = addAccount({ active: false, groups: ["g-eng", "unmanaged"] });
    const workflow = await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("rehearsed");
    expect(job.result).toEqual({
      account: "ada",
      would: "reactivate the account",
      groups_to_add: "Staff",
      groups_to_remove: "Engineering",
    });
    expect(STORE.accounts.get("u-ada")).toEqual(before);
    expect(STORE.calls).toEqual(["find"]);
    expect(await workflowStatus(workflow.id)).toBe("completed");
    expect(await personStatus(person.id)).toBe("active");
    expect(await count(tasks)).toBe(0);
    expect(await count(accounts)).toBe(0);
    const rehearsed = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "job.rehearsed"), eq(auditEvents.personId, person.id)));
    expect(rehearsed.length).toBeGreaterThan(0);
  });

  it("would create a missing account", async () => {
    const { person } = await standardSetup();
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await theJob();
    expect(job.result).toEqual({
      would: "create the account",
      groups_to_add: "Engineering, Staff",
      groups_to_remove: "none",
    });
    expect(STORE.accounts.size).toBe(0);
  });

  it("rehearses the removal of offboarding", async () => {
    const { person } = await standardSetup();
    await getDb().update(people).set({ status: "active" }).where(eq(people.id, person.id));
    const before = addAccount({ groups: ["g-staff", "unmanaged"] });
    const workflow = await startWorkflow(person.id, "offboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("rehearsed");
    expect(job.result.would).toBe("disable the account");
    expect(job.result.groups_to_remove).toBe("Staff");
    expect(STORE.accounts.get("u-ada")).toEqual(before);
    expect(await personStatus(person.id)).toBe("offboarded");
  });

  it("opens no task at connections without automation", async () => {
    const { connection, person } = await standardSetup();
    await getDb().update(connections).set({ mode: "manual" }).where(eq(connections.id, connection.id));
    const workflow = await startWorkflow(person.id, "onboarding");
    expect((await jobOf(workflow.id)).status).toBe("queued");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("rehearsed");
    expect(job.result.would).toBe("ask a person to make the change");
    expect(job.result.steps).toContain("Staff");
    expect(await count(tasks)).toBe(0);
    expect(STORE.calls).toEqual([]);
  });

  it("still stops the job at someone else's account", async () => {
    const { connection, person } = await standardSetup();
    const other = await makePerson({
      firstName: "Grace",
      lastName: "Hopper",
      workEmail: null,
      personalEmail: "",
    });
    addAccount();
    await getDb()
      .insert(accounts)
      .values({ connectionId: connection.id, personId: other.id, externalId: "u-ada", username: "ada" });
    await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await theJob();
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("belongs to Grace Hopper");
    expect(STORE.accounts.get("u-ada")!.active).toBe(true);
  });

  it("predicts in a rehearsal what the adapter does", async () => {
    // Offboarding deactivates a Relution user who is locked but activated:
    // unlocking would let the person in again. The rehearsal says so.
    const { connection, person } = await standardSetup();
    const fake = await relution(connection);
    await getDb().update(people).set({ status: "active" }).where(eq(people.id, person.id));
    fake.addUser("u-1", "ada@example.invalid", { locked: true });
    const workflow = await startWorkflow(person.id, "offboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("rehearsed");
    expect(job.result).toEqual({ account: "ada@example.invalid", would: "disable the account" });
    expect(fake.writes).toEqual([]);
    overrideConfigForTests({ READ_ONLY: false });
    await getDb().update(jobs).set({ status: "queued" }).where(eq(jobs.id, job.id));
    await runAll();
    expect(fake.users.get("u-1")!.activated).toBe(false);
  });

  it("fails the rehearsal of a job the connection would refuse", async () => {
    const { connection, person } = await standardSetup();
    const fake = await relution(connection);
    fake.addUser("u-1", "ada@example.invalid", { locked: true });
    const workflow = await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("failed");
    expect(job.lastError.startsWith("The Relution user is locked. Nothing was changed.")).toBe(true);
    expect(fake.writes).toEqual([]);
  });

  it("names the groups a refused offboarding removes first", async () => {
    vi.spyOn(FakeAdapter.prototype, "planDisable").mockImplementation(async function (
      this: FakeAdapter,
      spec: AccountSpec,
      account: ExternalAccount | null,
    ) {
      const plan = await Adapter.prototype.planDisable.call(this, spec, account);
      plan.refusal = "Fake app does not disable admins.";
      return plan;
    });
    const { person } = await standardSetup();
    await getDb().update(people).set({ status: "active" }).where(eq(people.id, person.id));
    addAccount({ groups: ["g-staff", "unmanaged"] });
    const workflow = await startWorkflow(person.id, "offboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toBe(
      "Fake app does not disable admins. The job would remove these groups first: Staff.",
    );
    expect(STORE.accounts.get("u-ada")!.groups).toEqual(new Set(["g-staff", "unmanaged"]));
  });

  it("fails the rehearsal when a group read fails", async () => {
    const { person } = await standardSetup();
    addAccount({ groups: ["g-staff"] });
    STORE.failGroupReadWith = new AdapterError("Fake app answered 403.");
    const workflow = await startWorkflow(person.id, "onboarding");
    await runAll();
    const job = await jobOf(workflow.id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toBe("Fake app answered 403.");
    expect(await workflowStatus(workflow.id)).toBe("failed");
  });

  it("gives adapters that can only read", async () => {
    const { connection } = await standardSetup();
    const adapter = buildAdapter(connection);
    // Python: isinstance(adapter, ReadOnlyAdapter); here the read-only wrapper is a Proxy.
    expect(types.isProxy(adapter)).toBe(true);
    expect((await adapter.testConnection()).ok).toBe(true);
    expect(await adapter.listAccounts()).toEqual([]);
    expect(adapter.supportsGroups).toBe(true);
    // Python: a read the fake adapter lacks reads as missing (None). Every
    // TypeScript adapter has canReadAccounts; the wrapper lets it through
    // with the adapter's own answer.
    expect(adapter.canReadAccounts()).toBe(true);
    for (const name of [
      "ensureAccount",
      "disableAccount",
      "createAccount",
      "setActive",
      "addToGroup",
      "removeFromGroup",
      "sendMessage",
      "anOperationAddedLater",
    ]) {
      expect(() => (adapter as unknown as Record<string, unknown>)[name], name).toThrow(ReadOnlyError);
      expect(() => (adapter as unknown as Record<string, unknown>)[name], name).toThrow(/Read-only mode/);
    }
  });

  it("still reads from connections", async () => {
    const { connection, person } = await standardSetup();
    addAccount({ groups: ["g-staff"] });
    expect((await importGroups(connection)).status).toBe("succeeded");
    const run = await compareAccounts(connection);
    expect(run.status, run.error).toBe("succeeded");
    const [account] = await getDb().select().from(accounts).where(eq(accounts.externalId, "u-ada"));
    expect(account!.personId).toBe(person.id);
  });

  it("lets no email leave the app", async () => {
    const sent: unknown[] = [];
    vi.spyOn(SmtpAdapter.prototype, "sendMessage").mockImplementation(async (message) => {
      sent.push(message);
    });
    await getDb().insert(connections).values({ adapter: "smtp", name: "Mail", enabled: true, settings: {} });
    await loadSettings();
    await getDb()
      .update(appSettings)
      .set({ notificationEmails: "it@example.invalid" })
      .where(eq(appSettings.id, 1));
    expect(await sendEmail(["ada@example.invalid"], "Hello", "Body")).toBe(false);
    await notifyTasks([{ title: "Something" }]);
    expect(sent).toEqual([]);
  });

  describe("pages", () => {
    let restoreSignIn: () => void;
    beforeEach(() => {
      restoreSignIn = signInWithTestHeader();
    });
    afterEach(() => restoreSignIn());

    it("says so on every page", async () => {
      // The web app's layout shows "Read-only mode." from /me (app-layout.tsx).
      const viewer = await makeUser("viewer");
      expect((await request("GET", "/api/v1/me", { user: viewer })).body.readOnly).toBe(true);
      overrideConfigForTests({ READ_ONLY: false });
      expect((await request("GET", "/api/v1/me", { user: viewer })).body.readOnly).toBe(false);
    });

    it("shows on the workflow page what each job would do", async () => {
      // The workflow page reads GET /api/v1/workflows/:id; Python's page shows
      // "Would <would> · add to <groups_to_add>" for each rehearsed job.
      const { person } = await standardSetup();
      const viewer = await makeUser("viewer");
      const workflow = await startWorkflow(person.id, "onboarding");
      await runAll();
      const page = await request("GET", `/api/v1/workflows/${workflow.id}`, { user: viewer });
      expect(page.status).toBe(200);
      const lines = (page.body.jobs as { status: string; result?: Record<string, string> }[])
        .filter((job) => job.status === "rehearsed")
        .map((job) => {
          const result = job.result ?? {};
          let line = `Would ${result.would}`;
          if (result.groups_to_add && result.groups_to_add !== "none")
            line += ` · add to ${result.groups_to_add}`;
          if (result.groups_to_remove && result.groups_to_remove !== "none")
            line += ` · remove from ${result.groups_to_remove}`;
          return line;
        });
      expect(lines).toContain("Would create the account · add to Engineering, Staff");
    });
  });

  it("reports the mode in the health check", async () => {
    const token = config().HEALTHCHECK_TOKEN;
    overrideConfigForTests({ HEALTHCHECK_TOKEN: "health-token" });
    try {
      const response = await request("GET", "/-/readyz", { headers: { "X-Health-Token": "health-token" } });
      expect(response.body.read_only).toBe(true);
    } finally {
      overrideConfigForTests({ HEALTHCHECK_TOKEN: token });
    }
  });

  it("accepts only a clear yes or no as the setting", () => {
    /** READ_ONLY=value as the process starts: the setting, or the error that stops the app. */
    function readOnlySetting(value: string): { value?: boolean; error?: string } {
      const saved = process.env.READ_ONLY;
      process.env.READ_ONLY = value;
      resetConfigForTests();
      try {
        return { value: config().READ_ONLY };
      } catch (error) {
        return { error: (error as Error).message };
      } finally {
        if (saved === undefined) delete process.env.READ_ONLY;
        else process.env.READ_ONLY = saved;
        resetConfigForTests();
      }
    }
    expect(readOnlySetting("1").value).toBe(true);
    expect(readOnlySetting("true").value).toBe(true);
    expect(readOnlySetting("").value).toBe(false);
    expect(readOnlySetting("0").value).toBe(false);
    const typo = readOnlySetting("ture");
    expect(typo.value).toBeUndefined();
    // Python: "READ_ONLY must be 1 or 0."; config.ts names the variable, then the problem.
    expect(typo.error).toContain("READ_ONLY: Must be 1 or 0");
  });
});
