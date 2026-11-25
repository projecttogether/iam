import {
  Adapter,
  AdapterError,
  SYNC_INTERVAL_FIELD,
  displayName,
  ensureResult,
  externalAccount,
  externalGroup,
  field,
  type AccountPlan,
  type AccountSpec,
  type EnsureResult,
  type ExternalAccount,
  type ExternalGroup,
  type JobActionName,
  type TestResult,
} from "./base";
import { type HttpClient, type HttpResponse } from "./http";

/** HubSpot users and teams, through the Settings Users API. */

export const API_URL = "https://api.hubapi.com";
export const USERS_PATH = "/settings/users/2026-03";
const NEEDS_EMAIL = "HubSpot accounts need a work email.";
const CANNOT_REACTIVATE =
  "HubSpot cannot reactivate a user through its API. Reactivate the user in HubSpot, then " +
  "run the job again.";
const TEAMS_PATH = `${USERS_PATH}/teams`;
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const INACTIVE_STATES = new Set([
  "archived",
  "deactivated",
  "deleted",
  "disabled",
  "inactive",
  "removed",
  "suspended",
]);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Json {
  return isRecord(value) ? value : {};
}

/** Whether a value is a team ID (Python: not in (None, "")). */
function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Whether a user answer holds anything (an empty object reads as no user). */
function present(user: Json | null): user is Json {
  return user !== null && Object.keys(user).length > 0;
}

function flag(value: unknown): boolean {
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function isActive(user: Json): boolean {
  const flags = ["archived", "deactivated", "deleted", "inactive", "suspended"];
  if (flags.some((name) => user[name] === true) || user.active === false) return false;
  const states = [user.status, user.state, user.userStatus];
  return !states.some((state) => state && INACTIVE_STATES.has(String(state).trim().toLowerCase()));
}

/** A path segment, percent-encoded like Python's quote(value, safe=''). */
function quote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class HubSpotAdapter extends Adapter {
  static override readonly slug = "hubspot";
  static override readonly label = "HubSpot";
  static override readonly description =
    "Invites HubSpot users, puts them in teams and removes them when access ends. " +
    "Seats and permission sets stay with HubSpot admins.";
  static override readonly supportsGroups = true;
  static override readonly groupLabel = "Teams";
  /** Removing the user ends its team memberships too. */
  static override readonly removeGroupsOnDisable = false;
  static override readonly fields = [
    field("access_token", "Private app access token", {
      kind: "secret",
      required: true,
      help:
        "A HubSpot private app with the scopes settings.users.read, " +
        "settings.users.write and settings.users.teams.read.",
    }),
    field("role_id", "Role ID for new users", {
      help: "Empty: HubSpot's default access. The ID is in Settings > Users & Teams > Roles.",
    }),
    field("send_welcome_email", "Send HubSpot's welcome email", {
      kind: "bool",
      default: true,
      help: "New users get HubSpot's invitation to set their password.",
    }),
    SYNC_INTERVAL_FIELD,
  ];

  private usersRouteConfirmed = false;

  // -- HTTP ------------------------------------------------------------------

  private client(): HttpClient {
    this.require("access_token");
    return this.http(API_URL, {
      headers: {
        Authorization: `Bearer ${this.setting<string>("access_token")}`,
        Accept: "application/json",
      },
    });
  }

  /** A request; status codes in `allow` are returned, not thrown. */
  private async request(
    method: string,
    url: string,
    what: string,
    options: { allow?: number[]; body?: Json; params?: Record<string, string> } = {},
  ): Promise<HttpResponse> {
    const response = await this.send(this.client(), method, url, what, {
      json: options.body,
      params: options.params,
    });
    if ((options.allow ?? []).includes(response.status)) return response;
    this.raiseForStatus(response, what);
    return response;
  }

  private static parse(response: HttpResponse): Json {
    if (response.status === 204 || !response.text) return {};
    try {
      return asRecord(response.json());
    } catch {
      return {};
    }
  }

  /**
   * The results of a listing and the whole answer. Anything else is an
   * error: read as empty, it would mark every account and team missing.
   */
  private results(response: HttpResponse, what: string): { results: Json[]; data: Json } {
    let data: unknown;
    try {
      data = response.json();
    } catch (error) {
      throw new AdapterError(`HubSpot sent an unreadable answer (${what}).`, { cause: error });
    }
    const results = isRecord(data) ? data.results : undefined;
    if (!Array.isArray(results) || !results.every(isRecord)) {
      throw new AdapterError(`HubSpot sent an unexpected answer (${what}).`);
    }
    return { results, data: asRecord(data) };
  }

  /**
   * A retired API version also answers 404. Only a working users route
   * shows that the user is the one missing.
   */
  private async requireUsersRoute(): Promise<void> {
    if (this.usersRouteConfirmed) return;
    const response = await this.request("GET", USERS_PATH, "list users", {
      allow: [404],
      params: { limit: "1" },
    });
    if (response.status === 404) {
      throw new AdapterError(
        "The HubSpot users API answered 404. Its version may have changed, so no " +
          "user can be confirmed missing.",
      );
    }
    this.usersRouteConfirmed = true;
  }

  // -- mapping -----------------------------------------------------------------

  private static teams(user: Json): [primary: string, secondary: string[]] {
    const primary = user.primaryTeamId;
    const ids = Array.isArray(user.secondaryTeamIds) ? (user.secondaryTeamIds as unknown[]) : [];
    const secondary = ids.filter(isSet).map(String);
    return [isSet(primary) ? String(primary) : "", secondary];
  }

  private toAccount(user: Json): ExternalAccount {
    const [primary, secondary] = HubSpotAdapter.teams(user);
    const teams = new Set([primary, ...secondary].filter((team) => team !== ""));
    const name = [user.firstName, user.lastName].filter((part) => part).join(" ");
    const email = user.email ? String(user.email) : "";
    return externalAccount(String(user.id ?? ""), {
      username: email,
      email,
      displayName: name,
      active: isActive(user),
      groups: teams,
    });
  }

  private async getUser(userId: string): Promise<Json | null> {
    const response = await this.request("GET", `${USERS_PATH}/${quote(userId)}`, "read a user", {
      allow: [404],
    });
    if (response.status === 404) return null;
    return HubSpotAdapter.parse(response);
  }

  private async getUserByEmail(email: string): Promise<Json | null> {
    // Encoded whole, so a '/' in the value cannot reach another path segment.
    const response = await this.request("GET", `${USERS_PATH}/${quote(email)}`, "look up a user", {
      allow: [404],
      params: { idProperty: "EMAIL" },
    });
    if (response.status === 404) {
      await this.requireUsersRoute();
      return null;
    }
    return HubSpotAdapter.parse(response);
  }

  // -- connection --------------------------------------------------------------

  override async testConnection(): Promise<TestResult> {
    try {
      await this.requireUsersRoute();
      await this.request("GET", TEAMS_PATH, "list teams");
    } catch (error) {
      if (error instanceof AdapterError) return { ok: false, message: error.message };
      throw error;
    }
    return { ok: true, message: "Connected to HubSpot. Users and teams can be read." };
  }

  // -- accounts ----------------------------------------------------------------

  override async findAccount(spec: AccountSpec, externalId = ""): Promise<ExternalAccount | null> {
    if (externalId) {
      const user = await this.getUser(externalId);
      if (present(user)) return this.toAccount(user);
    }
    if (!spec.email) return null;
    const user = await this.getUserByEmail(spec.email);
    return present(user) ? this.toAccount(user) : null;
  }

  override async createAccount(spec: AccountSpec): Promise<EnsureResult> {
    if (!spec.email) throw new AdapterError(NEEDS_EMAIL);
    const body: Json = {
      email: spec.email,
      firstName: spec.firstName,
      lastName: spec.lastName,
      sendWelcomeEmail: flag(this.setting("send_welcome_email", true)),
    };
    if (this.setting("role_id")) body.roleId = String(this.setting("role_id"));
    const response = await this.request("POST", USERS_PATH, "invite a user", { allow: [409], body });
    if (response.status === 409) {
      const user = await this.getUserByEmail(spec.email);
      if (!present(user)) {
        throw new AdapterError("HubSpot reports that the user already exists, but no user has this email.");
      }
      const account = this.toAccount(user);
      if (!account.active) {
        throw new AdapterError(
          "The HubSpot user exists but is deactivated. Reactivate it in HubSpot, " +
            "then run the job again.",
        );
      }
      return ensureResult(account, { notes: ["The HubSpot user already existed."] });
    }
    const account = this.toAccount(HubSpotAdapter.parse(response));
    const notes: string[] = [];
    if (body.sendWelcomeEmail) notes.push("HubSpot sent its invitation email.");
    notes.push("Seats and permission sets are assigned in HubSpot, not by this app.");
    return ensureResult(account, { created: true, notes });
  }

  override async planEnsure(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planEnsure(spec, account);
    if (plan.change === "create" && !spec.email) plan.refusal = NEEDS_EMAIL;
    else if (plan.change === "reactivate") plan.refusal = CANNOT_REACTIVATE;
    return plan;
  }

  override async planDisable(spec: AccountSpec, account: ExternalAccount | null): Promise<AccountPlan> {
    const plan = await super.planDisable(spec, account);
    // See setActive: HubSpot has no deactivation in its API.
    if (plan.change === "disable") plan.change = "delete";
    return plan;
  }

  override async setActive(account: ExternalAccount, active: boolean): Promise<ExternalAccount> {
    if (active) throw new AdapterError(CANNOT_REACTIVATE);
    // HubSpot has no deactivation in its API: removing the user ends access.
    // Records the user owns stay in HubSpot and keep the user's name.
    await this.request("DELETE", `${USERS_PATH}/${quote(account.externalId)}`, "remove a user", {
      allow: [404],
    });
    return { ...account, active: false, groups: new Set() };
  }

  override async listAccounts(): Promise<ExternalAccount[]> {
    const accounts: ExternalAccount[] = [];
    let after: unknown = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, string> = { limit: String(PAGE_SIZE) };
      if (after) params.after = String(after);
      const { results: users, data } = this.results(
        await this.request("GET", USERS_PATH, "list users", { params }),
        "list users",
      );
      for (const user of users) accounts.push(this.toAccount(user));
      after = asRecord(asRecord(data.paging).next).after;
      if (!after) return accounts;
    }
    return accounts;
  }

  // -- teams -------------------------------------------------------------------

  override async listGroups(): Promise<ExternalGroup[]> {
    const { results: teams } = this.results(
      await this.request("GET", TEAMS_PATH, "list teams"),
      "list teams",
    );
    return teams
      .filter((team) => isSet(team.id))
      .map((team) => externalGroup(String(team.id), team.name ? String(team.name) : String(team.id)));
  }

  private async setTeams(account: ExternalAccount, primary: string, secondary: string[]): Promise<void> {
    await this.request("PUT", `${USERS_PATH}/${quote(account.externalId)}`, "change a user's teams", {
      body: { primaryTeamId: primary || null, secondaryTeamIds: secondary },
    });
    account.groups = new Set([primary, ...secondary].filter((team) => team !== ""));
  }

  private async currentTeams(account: ExternalAccount): Promise<[primary: string, secondary: string[]]> {
    // Read again: each change replaces the user's whole team list.
    const user = await this.getUser(account.externalId);
    if (user === null) throw new AdapterError("The HubSpot user no longer exists.");
    return HubSpotAdapter.teams(user);
  }

  override async addToGroup(account: ExternalAccount, groupId: string): Promise<void> {
    let [primary, secondary] = await this.currentTeams(account);
    if (groupId === primary || secondary.includes(groupId)) return;
    if (!primary) primary = groupId;
    else secondary = [...secondary, groupId];
    await this.setTeams(account, primary, secondary);
  }

  override async removeFromGroup(account: ExternalAccount, groupId: string): Promise<void> {
    let [primary, secondary] = await this.currentTeams(account);
    if (groupId === primary) {
      primary = secondary[0] ?? "";
      secondary = secondary.slice(1);
    } else if (secondary.includes(groupId)) {
      const index = secondary.indexOf(groupId);
      secondary = [...secondary.slice(0, index), ...secondary.slice(index + 1)];
    } else {
      return;
    }
    await this.setTeams(account, primary, secondary);
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    if (action === "disable_account") {
      return (
        `In HubSpot, reassign the paid seat and owned records of ${who}, then remove ` +
        "or deactivate the user."
      );
    }
    const lines = [`Invite ${who} to HubSpot or make sure the user is active.`];
    if (groups.length > 0) lines.push(`Teams: ${groups.join(", ")}.`);
    lines.push("Assign the seat and permission set the person needs.");
    return lines.join("\n");
  }
}
