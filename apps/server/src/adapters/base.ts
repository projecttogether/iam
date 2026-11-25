import { randomInt } from "node:crypto";
import { config } from "../config";
import {
  HttpClient,
  type HttpResponse,
  HttpTimeoutError,
  HttpTransportError,
  type FetchLike,
  type RequestOptions,
} from "./http";

/**
 * The adapter interface. An adapter connects one kind of app or service.
 *
 * Admins create connections (configured adapters) in Admin › Connections.
 * The form there is generated from `fields`; values of `secret` fields are
 * stored encrypted and never shown again.
 *
 * Three kinds exist:
 *
 * - provisioning: accounts and groups in an app (Keycloak, Google Workspace,
 *   ...). Implement the primitives below; `ensureAccount` and
 *   `disableAccount` combine them and rarely need overriding. What they do
 *   to an account is decided once, from reads alone, in `planEnsure`,
 *   `planDisable` and `planGroups`: a job follows that plan, and read-only
 *   mode rehearses the job by describing it (`plan`). An adapter whose app
 *   does more or refuses something refines the plan there, so the rehearsal
 *   says what the job will do.
 * - hr_source: imports people (Personio). Implement `listPeople`.
 * - email: sends notifications and sign-in details (SMTP). Implement `send`.
 *
 * Adapters never touch the database: they get the configuration as an
 * object and return plain data. Errors they throw carry messages safe to
 * show to admins: never put tokens, passwords or full provider responses in
 * them.
 */

export const AdapterKind = {
  PROVISIONING: "provisioning",
  HR_SOURCE: "hr_source",
  EMAIL: "email",
} as const;
export type AdapterKind = (typeof AdapterKind)[keyof typeof AdapterKind];

export const ADAPTER_KIND_LABELS: Record<AdapterKind, string> = {
  provisioning: "Accounts and groups",
  hr_source: "People import",
  email: "Email",
};

export type FieldKind = "text" | "url" | "email" | "int" | "bool" | "choice" | "textarea" | "secret";

/** One setting of a connection, shown in the admin form. */
export type Field = {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  help: string;
  default: string | number | boolean | null;
  choices: [value: string, label: string][];
  placeholder: string;
  /**
   * Decides where the secrets are sent (a URL, a host, encryption on or off).
   * Changing it needs the saved secrets entered again.
   */
  destination: boolean;
};

export function field(
  name: string,
  label: string,
  options: Partial<Omit<Field, "name" | "label">> = {},
): Field {
  return {
    name,
    label,
    kind: options.kind ?? "text",
    required: options.required ?? false,
    help: options.help ?? "",
    default: options.default ?? null,
    choices: options.choices ?? [],
    placeholder: options.placeholder ?? "",
    destination: options.destination ?? false,
  };
}

export const SYNC_INTERVAL_FIELD = field("sync_interval_minutes", "Compare accounts every (minutes)", {
  kind: "int",
  default: 360,
  help: "How often the worker reads all accounts to find drift. 0 turns it off.",
});

/**
 * A provider call failed for a reason that retrying will not fix soon: bad
 * credentials, missing permissions, invalid data. The message is shown to
 * admins and must not contain secrets.
 */
export class AdapterError extends Error {
  readonly retryable: boolean = false;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterError";
  }
}

/** Timeouts, rate limits and server errors: the job runs again later. */
export class TransientError extends AdapterError {
  override readonly retryable: boolean = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientError";
  }
}

/** The connection's settings or credentials are wrong or incomplete. */
export class ConfigurationError extends AdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

/** Read-only mode stopped a change to a connected app, or an email. */
export class ReadOnlyError extends AdapterError {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyError";
  }
}

export type ExternalAccount = {
  externalId: string;
  username: string;
  email: string;
  displayName: string;
  active: boolean;
  /** External IDs of the groups the account is in; null when not read. */
  groups: Set<string> | null;
};

export function externalAccount(
  externalId: string,
  values: Partial<Omit<ExternalAccount, "externalId">> = {},
): ExternalAccount {
  return {
    externalId,
    username: values.username ?? "",
    email: values.email ?? "",
    displayName: values.displayName ?? "",
    active: values.active ?? true,
    groups: values.groups ?? null,
  };
}

export type ExternalGroup = { externalId: string; name: string; path: string; description: string };

export function externalGroup(
  externalId: string,
  name: string,
  values: { path?: string; description?: string } = {},
): ExternalGroup {
  return { externalId, name, path: values.path ?? "", description: values.description ?? "" };
}

/** What the app knows about the person an account is for. */
export type AccountSpec = {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  personalEmail: string;
  jobTitle: string;
  personType: string;
  team: string;
  managerEmail: string;
  /** YYYY-MM-DD */
  startDate: string | null;
  /** YYYY-MM-DD */
  endDate: string | null;
};

export function accountSpec(
  values: Partial<AccountSpec> & Pick<AccountSpec, "firstName" | "lastName" | "username">,
): AccountSpec {
  return {
    email: "",
    personalEmail: "",
    jobTitle: "",
    personType: "",
    team: "",
    managerEmail: "",
    startDate: null,
    endDate: null,
    ...values,
  };
}

export function displayName(spec: AccountSpec): string {
  return `${spec.firstName} ${spec.lastName}`.trim();
}

export type EnsureResult = {
  kind: "ensure";
  account: ExternalAccount;
  created: boolean;
  reactivated: boolean;
  groupsAdded: string[];
  groupsRemoved: string[];
  /** Generated for a new account and delivered by email; never stored. */
  initialPassword: string | null;
  /**
   * Why the adapter could not arrange the first sign-in of a new account;
   * the engine asks a person to do it.
   */
  credentialsProblem: string;
  notes: string[];
  /** Why the groups were left unfinished. The account step still counts: a group never holds up onboarding. */
  groupError: Error | null;
};

export function ensureResult(
  account: ExternalAccount,
  values: Partial<Omit<EnsureResult, "kind" | "account">> = {},
): EnsureResult {
  return {
    kind: "ensure",
    account,
    created: false,
    reactivated: false,
    groupsAdded: [],
    groupsRemoved: [],
    initialPassword: null,
    credentialsProblem: "",
    notes: [],
    groupError: null,
    ...values,
  };
}

export type DisableResult = {
  kind: "disable";
  account: ExternalAccount | null;
  changed: boolean;
  groupsRemoved: string[];
  notes: string[];
  /** Why the groups were left unfinished. The account is disabled anyway: a group never holds up offboarding. */
  groupError: Error | null;
};

export function disableResult(
  account: ExternalAccount | null,
  values: Partial<Omit<DisableResult, "kind" | "account">> = {},
): DisableResult {
  return {
    kind: "disable",
    account,
    changed: false,
    groupsRemoved: [],
    notes: [],
    groupError: null,
    ...values,
  };
}

/**
 * ensure_account: create, reactivate or keep. disable_account: disable,
 * delete (the app deletes users it disables), already disabled, or no account.
 */
export type PlanChange =
  "create" | "reactivate" | "keep" | "disable" | "delete" | "already disabled" | "no account";

/**
 * What a job does at one account, decided from reads alone. The job carries
 * it out; a rehearsal in read-only mode describes it.
 */
export type AccountPlan = {
  change: PlanChange;
  /** More the job changes at the account, in words ("update the name"). */
  also: string[];
  /**
   * Why the job stops at the account step, as the message it fails with.
   * Nothing at the account changes, except that disabling removes the groups first.
   */
  refusal: string;
  /** The managed groups the job adds and removes; null when it leaves the groups alone. Only `plan` fills them in. */
  groupsToAdd: string[] | null;
  groupsToRemove: string[] | null;
};

export function accountPlan(
  change: PlanChange,
  values: Partial<Omit<AccountPlan, "change">> = {},
): AccountPlan {
  return { change, also: [], refusal: "", groupsToAdd: null, groupsToRemove: null, ...values };
}

export type TestResult = { ok: boolean; message: string };

/** One person as an HR system lists them. */
export type HRRecord = {
  externalId: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
  jobTitle: string;
  personType: string;
  team: string;
  managerEmail: string;
  /** YYYY-MM-DD */
  startDate: string | null;
  /** YYYY-MM-DD */
  endDate: string | null;
  /** False once the HR system marks the person as left or inactive. */
  active: boolean;
};

const PASSWORD_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!?";

export function generatePassword(length = 20): string {
  for (;;) {
    let value = "";
    for (let index = 0; index < length; index += 1)
      value += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[-_.!?]/.test(value))
      return value;
  }
}

/** Default of `found`: the operation looks the account up itself. */
export const LOOK_UP: unique symbol = Symbol("look up");
export type Found = ExternalAccount | null | typeof LOOK_UP;

export type AdapterOptions = {
  /** The connection's ID, for log entries. */
  connectionId?: number;
  /** Replaces `fetch` (tests). */
  fetch?: FetchLike;
};

export type JobActionName = "ensure_account" | "disable_account";

/** What every adapter class says about itself (static members). */
export interface AdapterInfo {
  readonly slug: string;
  /** The adapter's name in the admin section ("Keycloak"). */
  readonly label: string;
  readonly kind: AdapterKind;
  readonly description: string;
  readonly fields: readonly Field[];
  /** Provisioning: whether the app may change accounts. */
  readonly supportsWrite: boolean;
  readonly supportsGroups: boolean;
  readonly supportsAccountListing: boolean;
  /** Whether admins may add groups by hand (apps without a group API). */
  readonly manualGroups: boolean;
  /** Remove managed groups when an account is disabled. */
  readonly removeGroupsOnDisable: boolean;
  /** What a group is called in this app (shown in forms). */
  readonly groupLabel: string;
  /** Whether a connection with these (non-secret) settings has groups. */
  groupsEnabled(settings: Record<string, unknown>): boolean;
  /** Whether the adapter can import its groups. */
  importsGroups(): boolean;
}

export type AdapterClass = AdapterInfo &
  (new (config: Record<string, unknown>, options?: AdapterOptions) => Adapter);

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

export abstract class Adapter {
  static readonly slug: string = "";
  static readonly label: string = "";
  static readonly kind: AdapterKind = AdapterKind.PROVISIONING;
  static readonly description: string = "";
  static readonly fields: readonly Field[] = [];
  static readonly supportsWrite: boolean = true;
  static readonly supportsGroups: boolean = false;
  static readonly supportsAccountListing: boolean = true;
  static readonly manualGroups: boolean = false;
  static readonly removeGroupsOnDisable: boolean = true;
  static readonly groupLabel: string = "Groups";

  static groupsEnabled(this: AdapterInfo, _settings: Record<string, unknown>): boolean {
    return this.supportsGroups;
  }

  static importsGroups(this: AdapterClass): boolean {
    return this.supportsGroups && this.prototype.listGroups !== Adapter.prototype.listGroups;
  }

  readonly config: Record<string, unknown>;
  readonly options: AdapterOptions;
  /** Whether this adapter's connection has groups (the class's answer, or its settings'). */
  supportsGroups: boolean;

  constructor(config: Record<string, unknown>, options: AdapterOptions = {}) {
    const info = this.info;
    this.config = {};
    for (const spec of info.fields) if (spec.default !== null) this.config[spec.name] = spec.default;
    for (const [key, value] of Object.entries(config)) if (!isBlank(value)) this.config[key] = value;
    this.options = options;
    this.supportsGroups = info.supportsGroups;
  }

  /** The class's description of itself. */
  get info(): AdapterClass {
    return this.constructor as AdapterClass;
  }

  get slug(): string {
    return this.info.slug;
  }

  get label(): string {
    return this.info.label;
  }

  get kind(): AdapterKind {
    return this.info.kind;
  }

  get groupLabel(): string {
    return this.info.groupLabel;
  }

  get supportsAccountListing(): boolean {
    return this.info.supportsAccountListing;
  }

  get removeGroupsOnDisable(): boolean {
    return this.info.removeGroupsOnDisable;
  }

  // -- helpers ---------------------------------------------------------------

  setting<T = unknown>(name: string, fallback?: T): T {
    const value = this.config[name];
    return (isBlank(value) ? fallback : value) as T;
  }

  /** A text setting, trimmed; empty when unset. */
  text(name: string): string {
    const value = this.setting<unknown>(name, "");
    return typeof value === "string" ? value.trim() : String(value);
  }

  require(...names: string[]): void {
    const labels = new Map(this.info.fields.map((spec) => [spec.name, spec.label]));
    const missing = names
      .filter((name) => isBlank(this.setting(name)))
      .map((name) => labels.get(name) ?? name);
    if (missing.length > 0) throw new ConfigurationError(`Missing settings: ${missing.join(", ")}.`);
  }

  http(
    baseUrl = "",
    options: { headers?: Record<string, string>; timeoutSeconds?: number } = {},
  ): HttpClient {
    return new HttpClient({
      baseUrl,
      headers: options.headers,
      timeoutSeconds: options.timeoutSeconds ?? config().PROVIDER_TIMEOUT_SECONDS,
      fetch: this.options.fetch,
    });
  }

  /**
   * Turns an HTTP error status into an adapter error without echoing the
   * response body, which can contain request data.
   */
  raiseForStatus(response: HttpResponse, what: string): void {
    const status = response.status;
    if (status < 300) return;
    if (status < 400) {
      // Redirects are never followed (http.ts), so a redirect is no answer of
      // the app's API and never confirms that a request worked.
      throw new AdapterError(
        `${this.label} answered with a redirect (${status}) while trying to ${what}. ` +
          "Check the connection's URL.",
      );
    }
    if (status === 429 || status >= 500) {
      throw new TransientError(`${this.label} answered ${status} while trying to ${what}.`);
    }
    if (status === 401 || status === 403) {
      throw new ConfigurationError(
        `${this.label} refused access (${status}) while trying to ${what}. ` +
          "Check the connection's credentials and permissions.",
      );
    }
    throw new AdapterError(`${this.label} answered ${status} while trying to ${what}.`);
  }

  /**
   * Stops at a user found by username whose emails are known and none is
   * the person's work email. A username can belong to someone else (another
   * J. Smith); a different email shows it does.
   */
  checkSameEmail(username: string, emails: Iterable<unknown>, spec: AccountSpec): void {
    const known = new Set<string>();
    for (const email of emails) {
      const value = String(email ?? "")
        .trim()
        .toLowerCase();
      if (value) known.add(value);
    }
    if (known.size > 0 && spec.email && !known.has(spec.email.trim().toLowerCase())) {
      throw new AdapterError(
        `The ${this.label} username ${username} belongs to a user with a different ` +
          "email. Nothing was changed. Check the person's username and work email.",
      );
    }
  }

  /** A request whose failures become adapter errors; an error status too. */
  async call(
    client: HttpClient,
    method: string,
    url: string,
    what: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    const response = await this.send(client, method, url, what, options);
    this.raiseForStatus(response, what);
    return response;
  }

  /** A request whose transport failures become adapter errors; the caller checks the status. */
  async send(
    client: HttpClient,
    method: string,
    url: string,
    what: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    try {
      return await client.request(method, url, options);
    } catch (error) {
      if (error instanceof HttpTimeoutError) {
        throw new TransientError(`${this.label} did not answer in time (${what}).`, { cause: error });
      }
      if (error instanceof HttpTransportError) {
        throw new TransientError(`Could not reach ${this.label} (${what}).`, { cause: error });
      }
      throw error;
    }
  }

  // -- all kinds -------------------------------------------------------------

  abstract testConnection(): Promise<TestResult>;

  // -- provisioning primitives -----------------------------------------------

  async listGroups(): Promise<ExternalGroup[]> {
    return [];
  }

  async findAccount(_spec: AccountSpec, _externalId = ""): Promise<ExternalAccount | null> {
    throw new Error("findAccount is not implemented");
  }

  async createAccount(_spec: AccountSpec): Promise<EnsureResult> {
    throw new Error("createAccount is not implemented");
  }

  async setActive(_account: ExternalAccount, _active: boolean): Promise<ExternalAccount> {
    throw new Error("setActive is not implemented");
  }

  async accountGroups(account: ExternalAccount): Promise<Set<string>> {
    return new Set(account.groups ?? []);
  }

  async addToGroup(_account: ExternalAccount, _groupId: string): Promise<void> {
    throw new Error("addToGroup is not implemented");
  }

  async removeFromGroup(_account: ExternalAccount, _groupId: string): Promise<void> {
    throw new Error("removeFromGroup is not implemented");
  }

  async listAccounts(): Promise<ExternalAccount[]> {
    return [];
  }

  /** Whether the connection can list accounts with its current settings (e.g. a token). */
  canReadAccounts(): boolean {
    return true;
  }

  /** The groups the app itself gives an account it creates. */
  async newAccountGroups(): Promise<Set<string>> {
    return new Set();
  }

  /**
   * Whether creating an account arranges its first sign-in, such as an
   * initial password or a setup email. A worker that stops between the
   * create and recording it loses that, and a person must check it.
   */
  handsOutSignIn(): boolean {
    return false;
  }

  /** Steps for a person when this app cannot or may not make a change. */
  manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    if (action === "disable_account") return `Remove or disable the ${this.label} account of ${who}.`;
    const lines = [`Make sure ${who} has an active ${this.label} account.`];
    if (groups.length > 0) lines.push(`${this.groupLabel}: ${groups.join(", ")}.`);
    return lines.join("\n");
  }

  // -- provisioning plans ----------------------------------------------------
  // Reads only. A job and its rehearsal both follow them; read-only mode lets
  // `plan` through, which runs the others.

  /** The account step of ensureAccount for the account findAccount found (null: no account). */
  async planEnsure(_spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    if (account === null) return accountPlan("create");
    return accountPlan(account.active ? "keep" : "reactivate");
  }

  /** The account step of disableAccount for the account found. */
  async planDisable(_spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    if (account === null) return accountPlan("no account");
    return accountPlan(account.active ? "disable" : "already disabled");
  }

  /** Whether a job with this action changes the account's groups. */
  changesGroups(action: JobActionName): boolean {
    if (!this.supportsGroups) return false;
    return action !== "disable_account" || this.removeGroupsOnDisable;
  }

  /**
   * The account's groups now, and the groups to add and remove so it is in
   * exactly the wanted managed groups. Groups the app does not manage stay.
   * For an account not yet created (null): the groups a new account gets.
   */
  async planGroups(
    account: ExternalAccount | null,
    wanted: Set<string>,
    managedGroups: Set<string>,
  ): Promise<{ current: Set<string>; add: string[]; remove: string[] }> {
    const current = account !== null ? await this.accountGroups(account) : await this.newAccountGroups();
    const add = [...wanted].filter((group) => !current.has(group)).sort();
    const remove = [...current].filter((group) => managedGroups.has(group) && !wanted.has(group)).sort();
    return { current, add, remove };
  }

  /**
   * What ensureAccount or disableAccount (`action`) would do with the account
   * found: the plan a rehearsal describes.
   */
  async plan(
    action: JobActionName,
    spec: AccountSpec,
    options: { found: ExternalAccount | null; groups: Set<string>; managedGroups: Set<string> },
  ): Promise<AccountPlan> {
    const disabling = action === "disable_account";
    const { found } = options;
    const plan = disabling ? await this.planDisable(spec, found) : await this.planEnsure(spec, found);
    // A refused ensure changes nothing; a refused disable removes the groups first.
    if ((plan.refusal && !disabling) || (disabling && found === null)) return plan;
    if (!this.changesGroups(action)) return plan;
    const wanted = disabling ? new Set<string>() : options.groups;
    try {
      const { add, remove } = await this.planGroups(found, wanted, options.managedGroups);
      plan.groupsToAdd = add;
      plan.groupsToRemove = remove;
    } catch (error) {
      // The job stops at the refusal whether or not it reads the groups.
      if (!plan.refusal) throw error;
    }
    return plan;
  }

  // -- provisioning operations ------------------------------------------------

  /**
   * Makes the account exist, be active and be in exactly the wanted managed
   * groups. Groups the app does not manage stay as they are. A failing group
   * step ends in `groupError`, never in an exception. `found` is the result
   * of a `findAccount` the caller already checked; the operation then
   * changes that account, not one it looks up again.
   */
  async ensureAccount(
    spec: AccountSpec,
    options: { externalId?: string; groups: Set<string>; managedGroups: Set<string>; found?: Found },
  ): Promise<EnsureResult> {
    const found = options.found === undefined ? LOOK_UP : options.found;
    let account = found === LOOK_UP ? await this.findAccount(spec, options.externalId ?? "") : found;
    const plan = await this.planEnsure(spec, account);
    if (plan.refusal) throw new AdapterError(plan.refusal);
    let result: EnsureResult;
    if (plan.change === "create") {
      result = await this.createAccount(spec);
      account = result.account;
    } else {
      result = ensureResult(account!);
      if (plan.change === "reactivate") {
        account = await this.setActive(account!, true);
        result.account = account;
        result.reactivated = true;
      }
    }
    if (this.changesGroups("ensure_account")) {
      const target = account!;
      try {
        const { current, add, remove } = await this.planGroups(target, options.groups, options.managedGroups);
        for (const groupId of add) {
          await this.addToGroup(target, groupId);
          result.groupsAdded.push(groupId);
        }
        for (const groupId of remove) {
          await this.removeFromGroup(target, groupId);
          result.groupsRemoved.push(groupId);
        }
        const removed = new Set(result.groupsRemoved);
        target.groups = new Set([...current, ...options.groups].filter((group) => !removed.has(group)));
      } catch (error) {
        result.groupError = asError(error);
        target.groups = null;
      }
    }
    return result;
  }

  async disableAccount(
    spec: AccountSpec,
    options: { externalId?: string; managedGroups: Set<string>; found?: Found },
  ): Promise<DisableResult> {
    const found = options.found === undefined ? LOOK_UP : options.found;
    const account = found === LOOK_UP ? await this.findAccount(spec, options.externalId ?? "") : found;
    const plan = await this.planDisable(spec, account);
    if (account === null) return disableResult(null, { notes: ["No account found; nothing to disable."] });
    const result = disableResult(account);
    if (this.changesGroups("disable_account")) {
      try {
        const { current, remove } = await this.planGroups(account, new Set(), options.managedGroups);
        for (const groupId of remove) {
          await this.removeFromGroup(account, groupId);
          result.groupsRemoved.push(groupId);
        }
        const removed = new Set(result.groupsRemoved);
        account.groups = new Set([...current].filter((group) => !removed.has(group)));
      } catch (error) {
        result.groupError = asError(error);
        account.groups = null;
      }
    }
    if (plan.refusal) throw new AdapterError(plan.refusal);
    if (plan.change === "disable" || plan.change === "delete") {
      result.account = await this.setActive(account, false);
      result.changed = true;
    }
    return result;
  }

  // -- other kinds -------------------------------------------------------------

  /** People an HR import skipped, with the reason: [source ID, reason]. */
  skipped: [string, string][] = [];

  async listPeople(): Promise<HRRecord[]> {
    throw new Error("listPeople is not implemented");
  }

  /** Email: sends one message (Python's `send`). */
  async sendMessage(_message: {
    to: string[];
    subject: string;
    body: string;
    replyTo?: string;
  }): Promise<void> {
    throw new Error("sendMessage is not implemented");
  }
}

/**
 * Python's str.casefold, closely enough to compare user names and emails:
 * upper then lower case, so ß and SS or ligatures compare equal, but the
 * dotless ı stays apart from i, as casefold keeps it.
 */
export function casefold(value: string): string {
  let folded = "";
  for (const character of value)
    folded += character === "ı" ? character : character.toUpperCase().toLowerCase();
  // Capital ẞ lowers to ß, which casefold writes as ss.
  return folded.replaceAll("ß", "ss");
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The members of an adapter that only read. In read-only mode
 * (READ_ONLY=1), a connection hands out `readOnly(adapter)` instead of the
 * adapter itself. Everything not named here, such as creating an account,
 * changing groups or sending email, throws ReadOnlyError before it reaches
 * the connected app. An operation added later stays blocked until it is
 * listed here as a read.
 */
const READS: ReadonlySet<string> = new Set<string>([
  // What the adapter is.
  "info",
  "slug",
  "label",
  "kind",
  "groupLabel",
  "supportsGroups",
  "supportsAccountListing",
  "removeGroupsOnDisable",
  // Reads. Some sign in first (an access token); none changes anything.
  "testConnection",
  "listGroups",
  "listAccounts",
  "canReadAccounts",
  "findAccount",
  "accountGroups",
  "plan",
  "listPeople",
  "skipped",
  "manualInstructions",
  "handsOutSignIn",
  "changesGroups",
]);

/** Whether read-only mode lets this member through. */
export function isRead(member: string): boolean {
  return READS.has(member);
}

export function readOnly<T extends Adapter>(adapter: T): T {
  const blocked = (property: string) =>
    new ReadOnlyError(
      `Read-only mode: ${adapter.label} was not changed (${property.replace(/([A-Z])/g, " $1").toLowerCase()}).`,
    );
  // The wrapper's own target is an empty object: nothing of the adapter
  // (its clients, its configuration) is reachable except through `get`.
  return new Proxy(Object.create(null) as T, {
    get(_target, property) {
      // Promise resolution looks for `then`; an adapter is no promise.
      if (typeof property === "symbol" || property === "then") return undefined;
      if (!READS.has(property)) throw blocked(property);
      const value = Reflect.get(adapter, property, adapter) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(adapter) : value;
    },
    has: (_target, property) => typeof property === "string" && READS.has(property),
    set: (_target, property) => {
      throw blocked(String(property));
    },
    defineProperty: (_target, property) => {
      throw blocked(String(property));
    },
    deleteProperty: (_target, property) => {
      throw blocked(String(property));
    },
    getOwnPropertyDescriptor: () => undefined,
    ownKeys: () => [],
    getPrototypeOf: () => null,
    setPrototypeOf: () => false,
  });
}
