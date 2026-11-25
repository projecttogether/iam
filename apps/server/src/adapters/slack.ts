import {
  Adapter,
  AdapterError,
  ConfigurationError,
  SYNC_INTERVAL_FIELD,
  TransientError,
  displayName,
  externalAccount,
  externalGroup,
  field,
  type AccountSpec,
  type ExternalAccount,
  type ExternalGroup,
  type JobActionName,
  type TestResult,
} from "./base";
import type { RequestOptions } from "./http";

/**
 * Slack: changes become tasks; a bot token lets the app read accounts.
 *
 * Slack's APIs for creating and deactivating members need Enterprise Grid (or
 * SCIM on Business+), so this adapter never writes: every account or channel
 * change becomes a manual task with the steps below. With a bot token
 * (scopes `users:read`, `users:read.email`, `channels:read`, `groups:read`) the
 * app reads members and channels, so it can compare accounts and import
 * channels as groups.
 *
 * Channel membership is not read: that needs one `conversations.members` call
 * per channel. Accounts therefore carry `groups: null` (not observed), and
 * `accountGroups` returns an empty set only because ensure/disable never run
 * for an adapter without writes; drift comparison skips channels.
 */

export const BASE_URL = "https://slack.com/api";
const MAX_PAGES = 500;

const CONFIGURATION_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);
const NOT_FOUND_ERRORS = new Set(["users_not_found", "user_not_found"]);

type Json = Record<string, unknown>;
type Params = NonNullable<RequestOptions["params"]>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truthiness: empty lists and objects count as nothing too. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `value or ""` as text. */
function str(value: unknown): string {
  return truthy(value) ? String(value) : "";
}

export class SlackApiError extends AdapterError {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export class SlackAdapter extends Adapter {
  static override readonly slug = "slack";
  static override readonly label = "Slack";
  static override readonly description =
    "Tracks Slack members. Invitations, channels and deactivations become tasks; " +
    "with a bot token the app reads members and channels to compare accounts.";
  static override readonly supportsWrite = false;
  static override readonly supportsGroups = true;
  // Without a token channels cannot be imported, so admins may add them by hand.
  static override readonly manualGroups = true;
  static override readonly groupLabel = "Channels";
  static override readonly fields = [
    field("bot_token", "Bot token", {
      kind: "secret",
      help:
        "Optional. A bot token (xoxb-...) with users:read, users:read.email, " +
        "channels:read and groups:read. Without it changes become tasks and " +
        "accounts are not compared.",
    }),
    field("workspace_url", "Workspace URL", {
      kind: "url",
      placeholder: "https://example.slack.com",
      help: "Linked in every task.",
    }),
    field("guest_types", "Invite as guests", {
      default: "external",
      help:
        "Person types invited as guests, comma-separated (employee, intern, " +
        "freelancer, volunteer, external). Everyone else becomes a full member.",
    }),
    SYNC_INTERVAL_FIELD,
  ];

  // -- API ---------------------------------------------------------------------

  override canReadAccounts(): boolean {
    return Boolean(this.setting("bot_token"));
  }

  private requireToken(): void {
    if (!this.canReadAccounts()) throw new ConfigurationError("Slack needs a bot token to read accounts.");
  }

  private async api(method: string, params: Params = {}): Promise<Json> {
    this.requireToken();
    const client = this.http(BASE_URL, {
      headers: { Authorization: `Bearer ${String(this.setting("bot_token"))}` },
    });
    const response = await this.call(client, "GET", `/${method}`, `call ${method}`, { params });
    let data: unknown;
    try {
      data = response.json();
    } catch (error) {
      throw new AdapterError(`Slack sent an unexpected answer to ${method}.`, { cause: error });
    }
    if (!isRecord(data) || typeof data.ok !== "boolean") {
      throw new AdapterError(`Slack sent an unexpected answer to ${method}.`);
    }
    if (data.ok) return data;
    // Error codes are fixed identifiers; keep only those characters.
    const code =
      (str(data.error) || "unknown_error")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 60) || "unknown_error";
    if (code === "ratelimited")
      throw new TransientError(`Slack rate-limited ${method}; it runs again later.`);
    if (CONFIGURATION_ERRORS.has(code)) {
      throw new ConfigurationError(`Slack refused ${method} (${code}). Check the bot token and its scopes.`);
    }
    throw new SlackApiError(`Slack answered ${method} with ${code}.`, code);
  }

  private async paged(method: string, key: string, params: Params): Promise<Json[]> {
    const items: Json[] = [];
    let cursor = "";
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageParams: Params = { ...params };
      if (cursor) pageParams.cursor = cursor;
      const data = await this.api(method, pageParams);
      const found = data[key];
      if (!Array.isArray(found)) throw new AdapterError(`Slack sent an unexpected answer to ${method}.`);
      items.push(...found.filter(isRecord));
      const metadata = truthy(data.response_metadata) ? data.response_metadata : {};
      cursor = isRecord(metadata) ? str(metadata.next_cursor) : "";
      if (!cursor) return items;
      if (seen.has(cursor)) throw new AdapterError(`Slack repeated a page of ${method}.`);
      seen.add(cursor);
    }
    throw new AdapterError(`Slack listed more than ${MAX_PAGES} pages of ${method}.`);
  }

  private static account(user: Json): ExternalAccount {
    const profile = isRecord(user.profile) ? user.profile : {};
    return externalAccount(str(user.id), {
      username: str(user.name),
      email: str(profile.email),
      displayName: str(truthy(profile.real_name) ? profile.real_name : user.real_name),
      active: !truthy(user.deleted),
      groups: null,
    });
  }

  private static isPerson(user: Json): boolean {
    return !(truthy(user.is_bot) || truthy(user.is_app_user) || user.id === "USLACKBOT");
  }

  // -- adapter -----------------------------------------------------------------

  override async testConnection(): Promise<TestResult> {
    if (!this.canReadAccounts()) {
      return { ok: true, message: "No token: changes become manual tasks and accounts are not compared." };
    }
    const data = await this.api("auth.test");
    const team = str(data.team) || str(data.team_id) || "the workspace";
    return { ok: true, message: `Connected to Slack workspace ${team}.` };
  }

  override async listGroups(): Promise<ExternalGroup[]> {
    if (!this.canReadAccounts()) {
      throw new ConfigurationError(
        "Slack needs a bot token to import channels. Add channels by hand instead.",
      );
    }
    const groups: ExternalGroup[] = [];
    const channels = await this.paged("conversations.list", "channels", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: 200,
    });
    for (const channel of channels) {
      if (truthy(channel.is_archived) || !truthy(channel.id)) continue;
      const purpose = isRecord(channel.purpose) ? channel.purpose : {};
      groups.push(
        externalGroup(String(channel.id), `#${String(truthy(channel.name) ? channel.name : channel.id)}`, {
          description: str(purpose.value),
        }),
      );
    }
    return groups;
  }

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    this.requireToken();
    if (externalId) {
      let data: Json | null = null;
      try {
        data = await this.api("users.info", { user: externalId });
      } catch (error) {
        if (!(error instanceof SlackApiError) || !NOT_FOUND_ERRORS.has(error.code)) throw error;
      }
      if (data !== null) {
        const user = data.user;
        if (isRecord(user) && truthy(user.id)) return SlackAdapter.account(user);
      }
    }
    if (!spec.email) return null;
    let data: Json;
    try {
      data = await this.api("users.lookupByEmail", { email: spec.email });
    } catch (error) {
      // Also the answer for deactivated members and pending invitations.
      if (error instanceof SlackApiError && NOT_FOUND_ERRORS.has(error.code)) return null;
      throw error;
    }
    const user = data.user;
    if (!isRecord(user) || !truthy(user.id)) {
      throw new AdapterError("Slack sent an unexpected answer to users.lookupByEmail.");
    }
    return SlackAdapter.account(user);
  }

  override async accountGroups(_account: ExternalAccount): Promise<Set<string>> {
    // Channel membership is not read (see the comment at the top).
    return new Set();
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    this.requireToken();
    const members = await this.paged("users.list", "members", { limit: 200 });
    return members
      .filter((user) => SlackAdapter.isPerson(user) && truthy(user.id))
      .map((user) => SlackAdapter.account(user));
  }

  private invitesAsGuest(personType: string): boolean {
    const types = new Set(
      String(this.setting("guest_types", ""))
        .split(",")
        .filter((item) => item.trim())
        .map((item) => item.trim().toLowerCase()),
    );
    return Boolean(personType) && types.has(personType.toLowerCase());
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    const url = this.setting("workspace_url");
    let lines: string[];
    if (action === "disable_account") {
      lines = [
        `Deactivate the Slack account of ${who}: Admin > Manage members > ` +
          "Deactivate account. Their messages and files stay in Slack.",
      ];
    } else {
      const role = this.invitesAsGuest(spec.personType) ? "a guest (multi-channel guest)" : "a full member";
      lines = [
        `Invite ${who} to the Slack workspace as ${role} with ${spec.email || "their work email"}.`,
        "If they already have a deactivated account, reactivate it instead.",
      ];
      if (groups.length > 0) lines.push(`Add them to these channels: ${groups.join(", ")}.`);
    }
    if (url) lines.push(`Workspace: ${String(url)}`);
    if (!this.canReadAccounts())
      lines.push("The app cannot read Slack, so completing this task records the change.");
    return lines.join("\n");
  }
}
