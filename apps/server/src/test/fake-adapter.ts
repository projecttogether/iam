import {
  AdapterError,
  Adapter,
  ensureResult,
  externalAccount,
  externalGroup,
  field,
  TransientError,
  type AccountSpec,
  type EnsureResult,
  type ExternalAccount,
  type ExternalGroup,
  type TestResult,
} from "../adapters/base";

/** An in-memory provisioning adapter for engine tests (port of tests/fakes.py). */

export type FakeAccount = { username: string; email: string; active: boolean; groups: Set<string> };

export class FakeStore {
  accounts = new Map<string, FakeAccount>();
  groups = new Map([
    ["g-staff", "Staff"],
    ["g-eng", "Engineering"],
    ["g-ops", "Operations"],
  ]);
  failWith: Error | null = null;
  /** Thrown once by the next addToGroup. */
  failGroupWith: Error | null = null;
  /** Thrown on every read of an account's groups while set. */
  failGroupReadWith: Error | null = null;
  calls: string[] = [];
  private nextId = 1;

  newId(): string {
    return `u${this.nextId++}`;
  }
}

export let STORE = new FakeStore();

export class FakeAdapter extends Adapter {
  static override readonly slug = "fake";
  static override readonly label = "Fake app";
  static override readonly supportsGroups = true;
  static override readonly fields = [
    field("url", "URL", { kind: "url", destination: true }),
    field("token", "Token", { kind: "secret", required: true }),
    field("sync_interval_minutes", "Compare every", { kind: "int", default: 0 }),
  ];
  /** The initial password a new account gets (null: none). */
  static password: string | null = null;
  static credentialsProblem = "";

  private maybeFail(call: string) {
    STORE.calls.push(call);
    if (STORE.failWith !== null) throw STORE.failWith;
  }

  override async testConnection(): Promise<TestResult> {
    this.maybeFail("test");
    return { ok: true, message: `Fake app with token ${String(this.config.token ?? "").length} chars.` };
  }

  override async listGroups(): Promise<ExternalGroup[]> {
    return [...STORE.groups].map(([id, name]) => externalGroup(id, name, { path: `/${name}` }));
  }

  external(accountId: string): ExternalAccount {
    const data = STORE.accounts.get(accountId)!;
    return externalAccount(accountId, {
      username: data.username,
      email: data.email,
      active: data.active,
      groups: new Set(data.groups),
    });
  }

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    this.maybeFail("find");
    if (STORE.accounts.has(externalId)) return this.external(externalId);
    for (const [id, data] of STORE.accounts) if (data.username === spec.username) return this.external(id);
    return null;
  }

  override async createAccount(spec: AccountSpec): Promise<EnsureResult> {
    const id = STORE.newId();
    STORE.accounts.set(id, { username: spec.username, email: spec.email, active: true, groups: new Set() });
    STORE.calls.push(`create:${spec.username}`);
    return ensureResult(this.external(id), {
      created: true,
      initialPassword: FakeAdapter.password,
      credentialsProblem: FakeAdapter.credentialsProblem,
    });
  }

  override handsOutSignIn(): boolean {
    return FakeAdapter.password !== null || Boolean(FakeAdapter.credentialsProblem);
  }

  override async setActive(account: ExternalAccount, active: boolean): Promise<ExternalAccount> {
    STORE.accounts.get(account.externalId)!.active = active;
    STORE.calls.push(`active:${account.externalId}:${active ? "True" : "False"}`);
    return this.external(account.externalId);
  }

  override async accountGroups(account: ExternalAccount): Promise<Set<string>> {
    if (STORE.failGroupReadWith !== null) throw STORE.failGroupReadWith;
    return new Set(STORE.accounts.get(account.externalId)!.groups);
  }

  override async addToGroup(account: ExternalAccount, groupId: string): Promise<void> {
    if (STORE.failGroupWith !== null) {
      const error = STORE.failGroupWith;
      STORE.failGroupWith = null;
      throw error;
    }
    STORE.accounts.get(account.externalId)!.groups.add(groupId);
  }

  override async removeFromGroup(account: ExternalAccount, groupId: string): Promise<void> {
    STORE.accounts.get(account.externalId)!.groups.delete(groupId);
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    this.maybeFail("list");
    return [...STORE.accounts.keys()].map((id) => this.external(id));
  }
}

/** A fresh store, and the adapter's class settings back to their defaults (the fake_store fixture). */
export function resetFakeStore(): FakeStore {
  STORE = new FakeStore();
  FakeAdapter.password = null;
  FakeAdapter.credentialsProblem = "";
  return STORE;
}

export { AdapterError, TransientError };
