import { isEmail } from "@iam/shared/email";
import { today as localToday, addDays } from "../core/time";
import {
  Adapter,
  AdapterError,
  AdapterKind,
  ConfigurationError,
  field,
  type HRRecord,
  type TestResult,
  casefold,
} from "./base";
import type { HttpClient, HttpResponse, RequestOptions } from "./http";

/**
 * Personio: imports people from the HR system. Read only.
 *
 * Uses the Personio Personnel Data API v1: POST /v1/auth with the API
 * credentials returns a bearer token; GET /v1/company/employees lists people
 * page by page. Custom attributes (private email, planned start date,
 * last day at work, supervisor) are found by their label through
 * GET /v1/company/employees/attributes and requested by key.
 *
 * Personio has three end dates: the contract end, the termination date and
 * the last day at work, which HR sets by hand in an offboarding. The record
 * carries all three; its end date, which offboarding follows, is the first
 * one set of last day at work, termination date and contract end.
 *
 * The adapter only reads Personio and returns HRRecord objects; the app
 * matches and creates people. Records it cannot read (missing name,
 * unreadable date) are skipped and listed in `skipped`, so one bad record
 * never blocks the rest.
 */

const PAGE_SIZE = 100;
const PERSON_TYPES = new Set(["employee", "intern", "freelancer", "volunteer", "external"]);
// Personio's employment_type is "internal" or "external".
const DEFAULT_TYPE_MAPPING = new Map([
  ["internal", "employee"],
  ["external", "external"],
]);
const INACTIVE_STATUSES = new Set(["inactive", "terminated", "terminated_with_access"]);
const EMPLOYMENT_TYPE_KEYS = ["employment_type", "employmentType", "Employment type"];
const POSITION_KEYS = ["position", "Position", "job_title"];
const PRIVATE_EMAIL_KEYS = [
  "private_email",
  "personal_email",
  "email_private",
  "privateEmail",
  "personalEmail",
  "private_email_address",
  "personal_email_address",
  "Private E-Mail-Adresse",
  "private e-mail adresse",
  "private email adresse",
  "private e-mail",
  "personal e-mail",
  "private email",
  "personal email",
  "e-mail privat",
  "email privat",
  "private mail",
  "privatmail",
];
const START_DATE_KEYS = [
  "hire_date",
  "start_date",
  "planned_start_date",
  "plannedStartDate",
  "planned start date",
  "planned hire date",
  "planned employment start date",
  "planned_start",
  "geplanter_start",
  "geplanter start",
  "geplanter eintritt",
  "geplantes eintrittsdatum",
  "geplanter starttermin",
  "starttermin",
  "eintrittsdatum",
  "eintritt",
];
const CONTRACT_END_KEYS = ["end_date", "contract_end_date"];
const TERMINATION_KEYS = ["termination_date"];
const LAST_DAY_AT_WORK_KEYS = [
  "last_working_day",
  "last_working_date",
  "last_day_of_work",
  "last day at work",
  "letzter arbeitstag",
];
const SUPERVISOR_KEYS = [
  "supervisor",
  "Supervisor",
  "responsible_person",
  "responsiblePerson",
  "Responsible person",
  "workplaces_supervisor",
  "workplacesSupervisor",
  "Workplaces Supervisor",
  "Workplace Supervisor",
];
const STANDARD_ATTRIBUTE_KEYS = [
  "first_name",
  "last_name",
  "email",
  "position",
  "department",
  "team",
  "status",
  "employment_type",
  ...START_DATE_KEYS,
  ...CONTRACT_END_KEYS,
  ...TERMINATION_KEYS,
  ...LAST_DAY_AT_WORK_KEYS,
  "private_email",
  "personal_email",
  "email_private",
  "private_email_address",
  "personal_email_address",
  ...SUPERVISOR_KEYS,
];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truthiness: empty lists and objects count as nothing too. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's `value not in (None, "")`. */
function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** `str(value or "")`. */
function str(value: unknown): string {
  return truthy(value) ? String(value) : "";
}

/** A whole number from a setting or an answer, as Python's int(); throws for anything else. */
function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  throw new TypeError(`Not a whole number: ${String(value)}`);
}

/** One employee record cannot be read. */
class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

export function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A key plus the label and universal ID Personio sends with it. */
export function attributeAliases(key: string, value: unknown): Set<string> {
  const aliases = new Set([normalizedKey(key)]);
  if (isRecord(value)) {
    for (const metadataKey of ["label", "universal_id"]) {
      const metadataValue = value[metadataKey];
      if (truthy(metadataValue)) aliases.add(normalizedKey(String(metadataValue)));
    }
  }
  return aliases;
}

/** Unwraps Personio's {"value": ...} and {"attributes": {"name": ...}} shapes. */
export function plainValue(value: unknown): unknown {
  if (isRecord(value) && Object.hasOwn(value, "value")) return plainValue(value.value);
  if (isRecord(value)) {
    const attributes = value.attributes;
    if (isRecord(attributes)) {
      for (const key of ["name", "label", "title"]) {
        if (truthy(attributes[key])) return plainValue(attributes[key]);
      }
    }
    for (const key of ["name", "label", "title"]) {
      if (truthy(value[key])) return plainValue(value[key]);
    }
    return "";
  }
  return value;
}

function byAlias(attributes: Json): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const [key, value] of Object.entries(attributes)) {
    for (const alias of attributeAliases(key, value)) if (!found.has(alias)) found.set(alias, value);
  }
  return found;
}

function lookup(attributes: Json, aliases: Map<string, unknown>, key: string): unknown {
  return Object.hasOwn(attributes, key) ? attributes[key] : aliases.get(normalizedKey(key));
}

function raw(attributes: Json, keys: readonly string[]): unknown {
  const aliases = byAlias(attributes);
  for (const key of keys) {
    const value = lookup(attributes, aliases, key);
    if (isSet(value)) return value;
  }
  return null;
}

export function text(attributes: Json, ...keys: string[]): string {
  const aliases = byAlias(attributes);
  for (const key of keys) {
    const value = plainValue(lookup(attributes, aliases, key));
    if (isSet(value)) return String(value).trim();
  }
  return "";
}

// -- dates ---------------------------------------------------------------------

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/** YYYY-MM-DD of a real calendar date (years 1 to 9999), or null. */
function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The date of an ISO week date (day 1 is Monday), or null. */
function weekDate(year: number, week: number, day: number): string | null {
  if (year < 1 || day < 1 || day > 7) return null;
  const january1 = new Date(Date.UTC(2000, 0, 1));
  january1.setUTCFullYear(year);
  const weekday = january1.getUTCDay() || 7;
  const isLeap = calendarDate(year, 2, 29) !== null;
  const weeks = weekday === 4 || (weekday === 3 && isLeap) ? 53 : 52;
  if (week < 1 || week > weeks) return null;
  // Monday of week 1 is the Monday of the week with January 4.
  const january4 = new Date(january1.getTime() + 3 * 86_400_000);
  const monday = new Date(january4.getTime() - ((january4.getUTCDay() || 7) - 1) * 86_400_000);
  const date = new Date(monday.getTime() + ((week - 1) * 7 + day - 1) * 86_400_000);
  const result = date.getUTCFullYear();
  if (result < 1 || result > 9999) return null;
  return `${pad(result, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

const ISO_DATE =
  /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})|(\d{4})-W(\d{2})(?:-(\d))?|(\d{4})W(\d{2})(\d)?)/u;
const FRACTION = "(?:[.,]\\d+)?";
const ISO_TIME = new RegExp(
  `^(?:(\\d{2})(?::(\\d{2})(?::(\\d{2})${FRACTION})?)?|(\\d{2})(?:(\\d{2})(?:(\\d{2})${FRACTION})?)?)` +
    `(?:Z|[+-](\\d{2})(?::?(\\d{2})(?::?(\\d{2})${FRACTION})?)?)?$`,
  "u",
);

/**
 * The date of an ISO 8601 date or date and time, as Python's
 * date.fromisoformat and datetime.fromisoformat().date() read it: the date
 * as written, whatever the offset. Null when it is none.
 */
function isoDate(value: string): string | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const numbers = match.map((part) => (part === undefined ? undefined : Number(part)));
  let date: string | null;
  if (match[1] !== undefined) date = calendarDate(numbers[1]!, numbers[2]!, numbers[3]!);
  else if (match[4] !== undefined) date = calendarDate(numbers[4]!, numbers[5]!, numbers[6]!);
  else if (match[7] !== undefined) date = weekDate(numbers[7]!, numbers[8]!, numbers[9] ?? 1);
  else date = weekDate(numbers[10]!, numbers[11]!, numbers[12] ?? 1);
  if (date === null) return null;
  const rest = [...value.slice(match[0].length)];
  if (rest.length === 0) return date;
  // Any one character separates the date and the time.
  const time = ISO_TIME.exec(rest.slice(1).join(""));
  if (!time) return null;
  const within = (part: string | undefined, limit: number) => part === undefined || Number(part) <= limit;
  const timeOk =
    within(time[1] ?? time[4], 23) && within(time[2] ?? time[5], 59) && within(time[3] ?? time[6], 59);
  const offsetOk = within(time[7], 23) && within(time[8], 59) && within(time[9], 59);
  return timeOk && offsetOk ? date : null;
}

/** DD.MM.YYYY, as Python's strptime(value, "%d.%m.%Y") reads it. */
function germanDate(value: string): string | null {
  const match = /^(3[01]|[12]\d|0[1-9]|[1-9])\.(1[0-2]|0[1-9]|[1-9])\.(\d{4})$/.exec(value);
  if (!match) return null;
  return calendarDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

/** The later of two YYYY-MM-DD dates; null only when both are. */
function later(first: string | null, second: string | null): string | null {
  if (first === null || second === null) return first ?? second;
  return first > second ? first : second;
}

export function parseDate(attributes: Json, ...keys: string[]): string | null {
  const value = text(attributes, ...keys);
  if (!value) return null;
  const date = germanDate(value) ?? isoDate(value);
  if (date === null) throw new RecordError(`unreadable date in ${keys[0]}`);
  return date;
}

// -- people --------------------------------------------------------------------

/** The supervisor's Personio ID and email (or name when there is none). */
export function supervisorReference(attributes: Json): [string, string] {
  const found = raw(attributes, SUPERVISOR_KEYS);
  if (!isSet(found)) return ["", ""];
  let value = isRecord(found) ? (Object.hasOwn(found, "value") ? found.value : found) : found;
  if (Array.isArray(value)) value = value.length > 0 ? value[0] : null;
  if (!isRecord(value)) return ["", isSet(value) ? String(value).trim() : ""];
  const employee = value.attributes;
  if (!isRecord(employee)) return [str(plainValue(value.id)).trim(), str(plainValue(value))];
  const sourceId = str(plainValue(employee.id)).trim();
  const email = text(employee, "email");
  if (email) return [sourceId, email];
  let name = text(employee, "display_name", "preferred_name");
  if (!name) name = `${text(employee, "first_name")} ${text(employee, "last_name")}`.trim();
  return [sourceId, name];
}

/**
 * The configured attribute's team name; department and team stand in for
 * each other when the configured one is empty.
 */
export function teamName(attributes: Json, attribute: string): string {
  const keys = [attribute];
  if (["department", "team"].includes(normalizedKey(attribute))) {
    keys.push(...["department", "team"].filter((key) => key !== normalizedKey(attribute)));
  }
  for (const key of keys) {
    const name = teamValue(raw(attributes, [key]));
    if (name) return name;
  }
  return "";
}

function teamValue(found: unknown): string {
  let value = isRecord(found) ? (Object.hasOwn(found, "value") ? found.value : found) : found;
  if (Array.isArray(value)) value = value.length > 0 ? value[0] : null;
  if (isRecord(value)) {
    const inner = Object.hasOwn(value, "attributes") ? value.attributes : value;
    if (isRecord(inner)) return text(inner, "name", "label", "title");
    return str(plainValue(value)).trim();
  }
  return str(value).trim();
}

export function recordId(found: unknown): string {
  if (!isRecord(found)) return "";
  const attributes = Object.hasOwn(found, "attributes") ? found.attributes : found;
  const nested = isRecord(attributes) ? plainValue(attributes.id) : "";
  return str(truthy(found.id) ? found.id : nested).trim();
}

type Entry = { record: HRRecord; supervisorId: string; supervisor: string };
type Page = { data: Json; page: unknown[] };

export class PersonioAdapter extends Adapter {
  static override readonly slug = "personio";
  static override readonly label = "Personio";
  static override readonly kind = AdapterKind.HR_SOURCE;
  static override readonly description =
    "Imports people from Personio: names, emails, team, manager, start and end dates. " +
    "Read only; nothing is written to Personio.";
  static override readonly supportsWrite = false;
  static override readonly supportsAccountListing = false;
  static override readonly fields = [
    field("client_id", "Client ID", {
      required: true,
      help: "Personio > Settings > Integrations > API credentials.",
    }),
    field("client_secret", "Client secret", { kind: "secret", required: true }),
    field("base_url", "API URL", { kind: "url", default: "https://api.personio.de", destination: true }),
    field("work_email_domains", "Work email domains", {
      help:
        "Comma-separated, e.g. example.invalid. Personio's email outside these domains " +
        "becomes the personal email. Empty: Personio's email is the work email.",
    }),
    field("type_mapping", "Person types", {
      kind: "textarea",
      help:
        "One line per value: 'Personio value = employee|intern|freelancer|volunteer|" +
        "external'. Matched against the employment type (internal, external), then " +
        "the position. Without a match: internal = employee, external = external, " +
        "anything else = employee.",
      placeholder: "Werkstudent = intern\nFreelancer = freelancer",
    }),
    field("team_attribute", "Team attribute", {
      default: "department",
      help: "The Personio attribute whose value names the team, e.g. department.",
    }),
    field("include_inactive_days", "List leavers for (days)", {
      kind: "int",
      default: 30,
      help: "People who left longer ago are no longer imported.",
    }),
    field("sync_interval_minutes", "Import people every (minutes)", {
      kind: "int",
      default: 60,
      help: "0 imports only when started by hand.",
    }),
  ];

  private token = "";
  private attributeKeys: string[] | null = null;

  // -- API -----------------------------------------------------------------------

  private client(): HttpClient {
    this.require("client_id", "client_secret");
    const baseUrl = String(this.setting("base_url")).replace(/\/+$/, "");
    if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
      throw new ConfigurationError("The API URL must start with https://.");
    }
    return this.http(baseUrl, { headers: { Accept: "application/json" } });
  }

  private json(response: HttpResponse, what: string): Json {
    let data: unknown;
    try {
      data = response.json();
    } catch (error) {
      throw new AdapterError(`Personio sent an unreadable answer (${what}).`, { cause: error });
    }
    if (!isRecord(data)) throw new AdapterError(`Personio sent an unexpected answer (${what}).`);
    return data;
  }

  private async request(
    client: HttpClient,
    method: string,
    path: string,
    what: string,
    options: RequestOptions = {},
  ): Promise<Json> {
    const headers = { ...options.headers, Authorization: `Bearer ${await this.accessToken(client)}` };
    const response = await this.call(client, method, path, what, { ...options, headers });
    return this.json(response, what);
  }

  private async accessToken(client: HttpClient): Promise<string> {
    if (this.token) return this.token;
    const response = await this.call(client, "POST", "/v1/auth", "sign in", {
      json: { client_id: this.setting("client_id"), client_secret: this.setting("client_secret") },
    });
    const data = this.json(response, "sign in");
    const payload = data.data;
    const token = isRecord(payload) ? payload.token : data.token;
    if (!truthy(token)) throw new ConfigurationError("Personio accepted the sign-in but sent no token.");
    this.token = String(token);
    return this.token;
  }

  /**
   * Standard keys plus custom attributes whose label names a private email,
   * a start date, the last day at work or a supervisor, and the team attribute.
   */
  private async employeeAttributeKeys(client: HttpClient): Promise<string[]> {
    if (this.attributeKeys !== null) return this.attributeKeys;
    const keys = [...STANDARD_ATTRIBUTE_KEYS];
    const teamAttribute = String(this.setting("team_attribute", "department"));
    if (!keys.includes(teamAttribute)) keys.push(teamAttribute);
    const wanted = new Set(
      [...PRIVATE_EMAIL_KEYS, ...START_DATE_KEYS, ...LAST_DAY_AT_WORK_KEYS, ...SUPERVISOR_KEYS].map(
        normalizedKey,
      ),
    );
    wanted.add(normalizedKey(teamAttribute));
    const data = await this.request(client, "GET", "/v1/company/employees/attributes", "read attributes");
    const attributes = data.data;
    if (!Array.isArray(attributes)) throw new AdapterError("Personio sent an unexpected attribute list.");
    for (const attribute of attributes as unknown[]) {
      if (!isRecord(attribute) || !truthy(attribute.key)) continue;
      const key = String(attribute.key);
      const matches = [...attributeAliases(key, attribute)].some((alias) => wanted.has(alias));
      if (matches && !keys.includes(key)) keys.push(key);
    }
    this.attributeKeys = keys;
    return keys;
  }

  private async *employeePages(client: HttpClient, maxPages: number | null = null): AsyncGenerator<Page> {
    const keys = await this.employeeAttributeKeys(client);
    let offset = 0;
    let pages = 0;
    for (;;) {
      const data = await this.request(client, "GET", "/v1/company/employees", "list employees", {
        params: { offset, limit: PAGE_SIZE, "attributes[]": keys },
      });
      const page = data.data;
      if (!Array.isArray(page)) throw new AdapterError("Personio sent an unexpected employee list.");
      yield { data, page };
      pages += 1;
      if (maxPages !== null && pages >= maxPages) return;
      const metadata = data.metadata;
      if (isRecord(metadata)) {
        const [current, total] = [metadata.current_page, metadata.total_pages];
        if (current !== null && current !== undefined && total !== null && total !== undefined) {
          if (toInt(current) >= toInt(total) - 1) return;
          offset += PAGE_SIZE;
          continue;
        }
      }
      if (page.length < PAGE_SIZE) return;
      offset += PAGE_SIZE;
    }
  }

  // -- mapping -------------------------------------------------------------------

  private configuredTypes(): Map<string, string> {
    const mapping = new Map<string, string>();
    // The line breaks of Python's str.splitlines().
    // eslint-disable-next-line no-control-regex -- \x1c-\x1e separate lines there.
    const lines = String(this.setting("type_mapping", "")).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    for (const line of lines) {
      if (!line.includes("=")) continue;
      const at = line.indexOf("=");
      const source = line.slice(0, at).trim();
      const target = line
        .slice(at + 1)
        .trim()
        .toLowerCase();
      if (source && PERSON_TYPES.has(target)) mapping.set(casefold(source), target);
    }
    return mapping;
  }

  /**
   * Configured employment type, then configured position, then the default
   * for the employment type, then employee.
   */
  private personType(employmentType: string, position: string): string {
    const configured = this.configuredTypes();
    for (const value of [employmentType, position]) {
      const type = value ? configured.get(casefold(value)) : undefined;
      if (type !== undefined) return type;
    }
    return DEFAULT_TYPE_MAPPING.get(casefold(employmentType)) ?? "employee";
  }

  private workDomains(): Set<string> {
    return new Set(
      String(this.setting("work_email_domains", ""))
        .split(",")
        .filter((domain) => domain.trim())
        .map((domain) => domain.trim().toLowerCase().replace(/^@+/, "")),
    );
  }

  /**
   * The record, the supervisor's Personio ID, and the supervisor reference.
   * Null when the person left before the listing window.
   */
  private record(found: unknown, today: string): Entry | null {
    if (!isRecord(found)) throw new RecordError("not an object");
    const attributes = Object.hasOwn(found, "attributes") ? found.attributes : found;
    if (!isRecord(attributes)) throw new RecordError("attributes are not an object");
    const externalId = recordId(found);
    const firstName = text(attributes, "first_name", "firstName");
    const lastName = text(attributes, "last_name", "lastName");
    if (!externalId || !firstName || !lastName) throw new RecordError("missing ID or name");

    const email = text(attributes, "email").toLowerCase();
    let personalEmail = text(attributes, ...PRIVATE_EMAIL_KEYS).toLowerCase();
    const domains = this.workDomains();
    let workEmail = isEmail(email) ? email : "";
    if (workEmail && domains.size > 0 && !domains.has(workEmail.slice(workEmail.lastIndexOf("@") + 1))) {
      if (!personalEmail) personalEmail = workEmail;
      workEmail = "";
    }
    if (!isEmail(personalEmail)) personalEmail = "";

    const status = text(attributes, "status").toLowerCase();
    const contractEndDate = parseDate(attributes, ...CONTRACT_END_KEYS);
    const terminationDate = parseDate(attributes, ...TERMINATION_KEYS);
    const lastDayAtWork = parseDate(attributes, ...LAST_DAY_AT_WORK_KEYS);
    // Access ends after the last day at work when HR set one; otherwise the
    // termination date wins over the contract end.
    const endDate = lastDayAtWork ?? terminationDate ?? contractEndDate;
    const active = !INACTIVE_STATUSES.has(status) && !(endDate !== null && endDate < today);
    // Leavers stay listed for a while after their employment ends so the app
    // sees them leave; without an end date the app cannot tell when, so they
    // stay listed.
    const windowDays = toInt(this.setting("include_inactive_days", 30) || 0);
    const leftOn = later(endDate, terminationDate ?? contractEndDate);
    if (!active && leftOn !== null && leftOn < addDays(today, -windowDays)) return null;

    const employmentType = text(attributes, ...EMPLOYMENT_TYPE_KEYS);
    const position = text(attributes, ...POSITION_KEYS);
    const personType = this.personType(employmentType, position);

    const [supervisorId, supervisor] = supervisorReference(attributes);
    const record: HRRecord = {
      externalId,
      firstName,
      lastName,
      workEmail,
      personalEmail,
      jobTitle: position,
      personType,
      team: teamName(attributes, String(this.setting("team_attribute", "department"))),
      managerEmail: isEmail(supervisor) ? supervisor.toLowerCase() : "",
      startDate: parseDate(attributes, ...START_DATE_KEYS),
      endDate,
      contractEndDate,
      terminationDate,
      lastDayAtWork,
      active,
    };
    return { record, supervisorId, supervisor };
  }

  // -- adapter interface -----------------------------------------------------------

  override async testConnection(): Promise<TestResult> {
    const client = this.client();
    let first: Page | undefined;
    for await (const page of this.employeePages(client, 1)) first = page;
    const { data, page } = first!;
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    let total = metadata.total_elements;
    if ((total === null || total === undefined) && toInt(metadata.total_pages || 1) <= 1) total = page.length;
    if (total === null || total === undefined) {
      return { ok: true, message: "Connected to Personio and read the first employees." };
    }
    const noun = toInt(total) === 1 ? "employee" : "employees";
    return { ok: true, message: `Connected to Personio: ${String(total)} ${noun}.` };
  }

  override async listPeople(): Promise<HRRecord[]> {
    this.skipped = [];
    const today = localToday();
    const entries: Entry[] = [];
    const client = this.client();
    for await (const { page } of this.employeePages(client)) {
      for (const found of page) {
        let entry: Entry | null;
        try {
          entry = this.record(found, today);
        } catch (error) {
          if (!(error instanceof RecordError)) throw error;
          this.skipped.push([recordId(found), error.message]);
          continue;
        }
        if (entry !== null) entries.push(entry);
      }
    }
    // A supervisor given only by Personio ID gets that person's work email.
    const emails = new Map(entries.map(({ record }) => [record.externalId, record.workEmail]));
    for (const { record, supervisorId } of entries) {
      if (!record.managerEmail && supervisorId) record.managerEmail = emails.get(supervisorId) ?? "";
    }
    return entries.map(({ record }) => record);
  }
}
