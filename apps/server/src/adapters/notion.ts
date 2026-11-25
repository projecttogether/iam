import {
  Adapter,
  AdapterError,
  ConfigurationError,
  SYNC_INTERVAL_FIELD,
  displayName,
  externalAccount,
  field,
  type AccountSpec,
  type ExternalAccount,
  type JobActionName,
  type TestResult,
} from "./base";
import { type HttpClient, type HttpResponse, type RequestOptions } from "./http";

/**
 * Notion: changes become tasks; an integration token lets the app read members.
 *
 * Notion's public API cannot invite or remove workspace members, so this
 * adapter never writes: every change becomes a manual task. With an internal
 * integration token that may read user information including email
 * addresses, the app lists members to compare accounts. Notion does not list
 * removed members and has no "deactivated" state, so every listed member is
 * active.
 */

export const BASE_URL = "https://api.notion.com";
export const NOTION_VERSION = "2022-06-28";
const MAX_PAGES = 500;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NotionAdapter extends Adapter {
  static override readonly slug = "notion";
  static override readonly label = "Notion";
  static override readonly description =
    "Tracks Notion workspace members. Invitations and removals become tasks; with " +
    "an integration token the app reads members to compare accounts.";
  static override readonly supportsWrite = false;
  static override readonly supportsGroups = false;
  static override readonly fields = [
    field("token", "Integration token", {
      kind: "secret",
      help:
        "Optional. An internal integration token with the capability " +
        "'Read user information including email addresses'. Without it changes " +
        "become tasks and accounts are not compared.",
    }),
    field("workspace_url", "Workspace URL", {
      kind: "url",
      placeholder: "https://www.notion.so/example",
      help: "Linked in every task.",
    }),
    SYNC_INTERVAL_FIELD,
  ];

  // -- API ---------------------------------------------------------------------

  override canReadAccounts(): boolean {
    return Boolean(this.setting("token"));
  }

  private requireToken(): void {
    if (!this.canReadAccounts()) throw new ConfigurationError("Notion needs a token to read accounts.");
  }

  private client(): HttpClient {
    this.requireToken();
    return this.http(BASE_URL, {
      headers: {
        Authorization: `Bearer ${this.setting<string>("token")}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
      },
    });
  }

  private json(response: HttpResponse, what: string): Json {
    let data: unknown;
    try {
      data = response.json();
    } catch (error) {
      throw new AdapterError(`Notion sent an unexpected answer (${what}).`, { cause: error });
    }
    if (!isRecord(data)) throw new AdapterError(`Notion sent an unexpected answer (${what}).`);
    return data;
  }

  private async get(path: string, what: string, params: RequestOptions["params"] = {}): Promise<Json> {
    const response = await this.call(this.client(), "GET", path, what, { params });
    return this.json(response, what);
  }

  /** One user by ID, or null when Notion does not know the ID. */
  private async getUser(userId: string): Promise<Json | null> {
    const what = "read a user";
    const response = await this.send(this.client(), "GET", `/v1/users/${userId}`, what);
    // 400: not a valid user ID; 404: unknown or no longer a member.
    if (response.status === 400 || response.status === 404) return null;
    this.raiseForStatus(response, what);
    return this.json(response, what);
  }

  private async *users(): AsyncGenerator<Json> {
    let cursor = "";
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, string | number> = { page_size: 100 };
      if (cursor) params.start_cursor = cursor;
      const data = await this.get("/v1/users", "list users", params);
      const results = data.results;
      if (!Array.isArray(results) || typeof data.has_more !== "boolean") {
        throw new AdapterError("Notion sent an unexpected answer (list users).");
      }
      for (const user of results) if (isRecord(user)) yield user;
      if (!data.has_more) return;
      cursor = data.next_cursor ? String(data.next_cursor) : "";
      if (!cursor || seen.has(cursor)) throw new AdapterError("Notion sent inconsistent pages (list users).");
      seen.add(cursor);
    }
    throw new AdapterError(`Notion listed more than ${MAX_PAGES} pages of users.`);
  }

  private static email(user: Json): string {
    const person = isRecord(user.person) ? user.person : {};
    return person.email ? String(person.email) : "";
  }

  private static toAccount(user: Json): ExternalAccount {
    const email = NotionAdapter.email(user);
    return externalAccount(user.id ? String(user.id) : "", {
      username: email,
      email,
      displayName: user.name ? String(user.name) : "",
      active: true,
    });
  }

  // -- adapter -------------------------------------------------------------------

  override async testConnection(): Promise<TestResult> {
    if (!this.canReadAccounts()) {
      return { ok: true, message: "No token: changes become manual tasks and accounts are not compared." };
    }
    const data = await this.get("/v1/users/me", "read the integration");
    const bot = isRecord(data.bot) ? data.bot : {};
    const workspace = bot.workspace_name ? String(bot.workspace_name) : "";
    return {
      ok: true,
      message: workspace ? `Connected to Notion workspace ${workspace}.` : "Connected to Notion.",
    };
  }

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    this.requireToken();
    if (externalId) {
      const user = await this.getUser(externalId);
      if (user && user.type === "person") return NotionAdapter.toAccount(user);
    }
    if (!spec.email) return null;
    const wanted = spec.email.toLowerCase();
    let hidden = false;
    for await (const user of this.users()) {
      if (user.type !== "person") continue;
      const email = NotionAdapter.email(user);
      if (!email) hidden = true;
      else if (email.toLowerCase() === wanted) return NotionAdapter.toAccount(user);
    }
    if (hidden) {
      // A member without a visible email could be this person.
      throw new AdapterError(
        "Notion hides the email address of some members, so this account " +
          "cannot be found. Give the integration the capability 'Read user " +
          "information including email addresses'.",
      );
    }
    return null;
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    this.requireToken();
    const accounts: ExternalAccount[] = [];
    for await (const user of this.users()) {
      if (user.type === "person" && user.id) accounts.push(NotionAdapter.toAccount(user));
    }
    return accounts;
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, _groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    const url = this.setting<unknown>("workspace_url");
    let lines: string[];
    if (action === "disable_account") {
      lines = [
        `Remove ${who} from the Notion workspace: Settings > People > ` + "Remove from workspace.",
        "Transfer their private pages first if the team still needs them.",
      ];
    } else {
      lines = [
        `Invite ${who} to the Notion workspace as a member with ` + `${spec.email || "their work email"}.`,
        "Add them to the teamspaces their team uses.",
      ];
    }
    if (url) lines.push(`Workspace: ${String(url)}`);
    if (!this.canReadAccounts()) {
      lines.push("The app cannot read Notion, so completing this task records the change.");
    }
    return lines.join("\n");
  }
}
