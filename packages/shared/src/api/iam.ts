import { z } from "zod";
import { isEmail } from "../email";
import type {
  AccountStatus,
  AdapterKind,
  IdentityRequestStatus,
  ConnectionMode,
  ConnectionStatus,
  JobAction,
  JobStatus,
  PersonStatus,
  PersonType,
  Role,
  SyncKind,
  SyncStatus,
  TaskKind,
  TaskStatus,
  WorkflowKind,
  WorkflowStatus,
} from "../labels";
import { CONNECTION_MODE_LABELS, PERSON_TYPE_LABELS, ROLE_LABELS, WORKFLOW_KIND_LABELS } from "../labels";

/*
 * The API of the web app (/api/v1). Dates are YYYY-MM-DD, times ISO 8601.
 * Request bodies are validated with the schemas here; their messages are the
 * Django version's form messages.
 */

// -- common ---------------------------------------------------------------------------

/** A page of a list: 50 rows (the audit log 100), `page` from 1. */
export type Paged<T> = { items: T[]; page: number; pages: number; total: number };

export type Ref = { id: number; name: string };

/** An audit event as lists show it. */
export type EventRow = {
  id: number;
  createdAt: string;
  actorLabel: string;
  action: string;
  summary: string;
  person: Ref | null;
};

export type TaskRow = {
  id: number;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  createdAt: string;
  person: Ref | null;
  connection: Ref | null;
  jobId: number | null;
};

export type JobRow = {
  id: number;
  action: JobAction;
  status: JobStatus;
  attempts: number;
  lastError: string;
  /** What the job did, or in read-only mode would do (`would`, `groups_to_add`, `groups_to_remove`). */
  result: Record<string, unknown>;
  createdAt: string;
  nextAttemptAt: string;
  person: Ref;
  connection: Ref;
  workflow: { id: number; kind: WorkflowKind };
};

export type WorkflowRow = {
  id: number;
  kind: WorkflowKind;
  status: WorkflowStatus;
  reason: string;
  automatic: boolean;
  createdAt: string;
  finishedAt: string | null;
  person: Ref;
  createdBy: string | null;
};

// -- the signed-in user ----------------------------------------------------------------

/** Public: what the sign-in page shows. */
export type AuthConfig = {
  appName: string;
  /** Whether the request came with a session (the sign-in page then moves on). */
  signedIn: boolean;
  providerName: string;
  oidcEnabled: boolean;
  devLogin: boolean;
};

export type Me = {
  id: number;
  email: string;
  name: string;
  role: Role;
  isAdmin: boolean;
  isApprover: boolean;
  organizationName: string;
  /** The provider's account page (Keycloak), or empty. */
  accountUrl: string;
  readOnly: boolean;
  version: string;
  /** For the sidebar. */
  counts: { openTasks: number; failedJobs: number; heldJobs: number; openRequests: number };
};

export const devLoginSchema = z.object({ email: z.string().min(1).max(254) });

// -- dashboard -------------------------------------------------------------------------

export type PersonDateRow = { id: number; name: string; date: string; status: PersonStatus };

export type Dashboard = {
  peopleCounts: Record<PersonStatus, number>;
  openTasks: number;
  failedJobs: number;
  heldJobs: number;
  openWorkflows: number;
  connections: number;
  connectionErrors: { id: number; name: string; message: string }[];
  starting: PersonDateRow[];
  leaving: PersonDateRow[];
  recentEvents: EventRow[];
  worker: { stale: boolean; beatAt: string | null; maxAgeSeconds: number };
};

// -- people ----------------------------------------------------------------------------

export type PersonRow = {
  id: number;
  name: string;
  workEmail: string | null;
  personType: PersonType;
  status: PersonStatus;
  team: string | null;
  accessProfile: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type PersonOptions = {
  teams: Ref[];
  profiles: (Ref & { defaultFor: PersonType[] })[];
  managers: Ref[];
};

export type AccessRow = {
  connection: Ref;
  /** What profile and team grant there; null: no access. */
  grant: { groups: { label: string; reasons: string[] }[] } | null;
  account: { label: string; status: AccountStatus; observedAt: string | null } | null;
};

export type PersonDetail = {
  id: number;
  firstName: string;
  lastName: string;
  name: string;
  workEmail: string | null;
  personalEmail: string;
  username: string;
  loginName: string;
  jobTitle: string;
  personType: PersonType;
  status: PersonStatus;
  team: Ref | null;
  manager: Ref | null;
  accessProfile: Ref | null;
  startDate: string | null;
  endDate: string | null;
  source: { connection: string; id: string } | null;
  notes: string;
  onboardingPaused: boolean;
  today: string;
  accessRows: AccessRow[];
  workflows: WorkflowRow[];
  openJobs: JobRow[];
  tasks: TaskRow[];
  events: EventRow[];
  can: { onboard: boolean; update: boolean; offboard: boolean; archive: boolean };
};

/** A real calendar date as YYYY-MM-DD (not 2026-02-30). */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "0001-01-01";
}

const trimmed = (max: number, message?: string) =>
  z
    .string()
    .trim()
    .max(max, message ?? `Ensure this value has at most ${max} characters.`);
const required = (max: number) => trimmed(max).min(1, "This field is required.");
const emailField = z
  .string()
  .trim()
  .max(254, "Ensure this value has at most 254 characters.")
  .refine((value) => value === "" || isEmail(value), "Enter a valid email address.");
const dateField = z
  .string()
  .trim()
  .refine((value) => value === "" || isCalendarDate(value), "Enter a valid date.")
  .transform((value) => value || null)
  .nullable()
  .optional()
  .transform((value) => value ?? null);
const idField = z
  .union([z.number().int().positive(), z.null(), z.literal("")])
  .optional()
  .transform((value) => (typeof value === "number" ? value : null));

export const PERSON_TYPES = Object.keys(PERSON_TYPE_LABELS) as PersonType[];

export const personInputSchema = z
  .object({
    firstName: required(150),
    lastName: required(150),
    workEmail: emailField,
    personalEmail: emailField,
    username: trimmed(150),
    jobTitle: trimmed(200),
    personType: z.enum(PERSON_TYPES as [PersonType, ...PersonType[]], "Select a valid choice."),
    teamId: idField,
    managerId: idField,
    accessProfileId: idField,
    startDate: dateField,
    endDate: dateField,
    notes: z.string().max(100_000),
  })
  .superRefine((value, ctx) => {
    if (value.startDate && value.endDate && value.endDate < value.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "The last day cannot be before the start date.",
      });
    }
  });
export type PersonInput = z.input<typeof personInputSchema>;

export const startWorkflowSchema = z.object({ reason: z.string().max(300).optional() });

export const WORKFLOW_KINDS = Object.keys(WORKFLOW_KIND_LABELS) as WorkflowKind[];

// -- teams and access profiles -----------------------------------------------------------

/** A connection whose groups a team or profile can choose. */
export type GroupConnection = {
  id: number;
  name: string;
  enabled: boolean;
  mode: ConnectionMode;
  groupLabel: string;
  supportsGroups: boolean;
  groups: { id: number; label: string }[];
};

export type TeamRow = {
  id: number;
  name: string;
  description: string;
  memberCount: number;
  groups: { label: string; connection: string }[];
};

export type TeamDetail = {
  id: number;
  name: string;
  description: string;
  members: { id: number; name: string; status: PersonStatus; accessProfile: string | null }[];
  groups: { id: number; label: string; connection: string; missing: boolean }[];
  groupIds: number[];
};

export const teamInputSchema = z.object({
  name: required(200),
  description: z.string().max(100_000),
  groupIds: z.array(z.number().int().positive()).max(5000),
});
export type TeamInput = z.input<typeof teamInputSchema>;

export type ProfileRow = {
  id: number;
  name: string;
  description: string;
  defaultFor: PersonType[];
  peopleCount: number;
  grants: { connection: string; groups: string[] }[];
};

export type ProfileDetail = {
  id: number;
  name: string;
  description: string;
  defaultFor: PersonType[];
  grants: {
    connection: Ref & { enabled: boolean };
    groups: { id: number; label: string; missing: boolean }[];
  }[];
  people: { id: number; name: string; status: PersonStatus; team: string | null }[];
};

export const profileInputSchema = z.object({
  name: required(200),
  description: z.string().max(100_000),
  defaultFor: z
    .array(z.enum(PERSON_TYPES as [PersonType, ...PersonType[]], "Select a valid choice."))
    .max(10),
  /** The connections that grant an account, with their groups. */
  grants: z
    .array(
      z.object({
        connectionId: z.number().int().positive(),
        groupIds: z.array(z.number().int().positive()).max(5000),
      }),
    )
    .max(500),
});
export type ProfileInput = z.input<typeof profileInputSchema>;

// -- work ---------------------------------------------------------------------------------

export type WorkflowDetail = WorkflowRow & {
  isOpen: boolean;
  desired: { connection: string; groups: string[] }[];
  jobs: JobRow[];
  tasks: TaskRow[];
  /** Why a cancel came too late for jobs that ran, when it did. */
  tooLate: string;
};

export type JobDetail = JobRow & {
  groups: string[];
  finishedAt: string | null;
  result: Record<string, unknown>;
  tasks: TaskRow[];
  events: EventRow[];
};

export type TaskDetail = TaskRow & {
  instructions: string;
  completedAt: string | null;
  completedBy: string | null;
  note: string;
};

export const taskCloseSchema = z.object({ note: z.string().max(2000).optional() });

/** Messages after an action, e.g. a cancel that came too late for running jobs. */
export type ActionResult = { message: string; id?: number };

// -- connections ---------------------------------------------------------------------

export type AdapterField = {
  name: string;
  label: string;
  kind: "text" | "url" | "email" | "int" | "bool" | "choice" | "textarea" | "secret";
  required: boolean;
  help: string;
  default: string | number | boolean | null;
  choices: [string, string][];
  placeholder: string;
};

export type AdapterInfo = {
  slug: string;
  name: string;
  kind: AdapterKind;
  description: string;
  fields: AdapterField[];
  /** Whether the form has a mode (accounts and groups that the app may change). */
  hasMode: boolean;
  supportsWrite: boolean;
  supportsGroups: boolean;
  groupLabel: string;
  manualGroups: boolean;
};

export type ConnectionRow = {
  id: number;
  name: string;
  adapterName: string;
  enabled: boolean;
  status: ConnectionStatus;
  mode: ConnectionMode;
  kind: AdapterKind | "";
  checkedAt: string | null;
};

export type ConnectionDetail = ConnectionRow & {
  adapter: AdapterInfo | null;
  statusMessage: string;
  checkedAt: string | null;
  settings: { label: string; kind: string; value: unknown }[];
  secrets: { label: string; saved: boolean }[];
  supportsGroups: boolean;
  canImportGroups: boolean;
  canCompare: boolean;
  syncIntervalMinutes: number;
  groupsSyncedAt: string | null;
  groups: { id: number; label: string; externalId: string; missing: boolean; manual: boolean }[];
  accounts: {
    id: number;
    label: string;
    person: Ref | null;
    status: AccountStatus;
    observedAt: string | null;
  }[];
  accountCount: number;
  syncRuns: {
    id: number;
    kind: SyncKind;
    status: SyncStatus;
    startedAt: string;
    triggeredBy: string | null;
    error: string;
    summary: string;
  }[];
  grants: Ref[];
  deletable: boolean;
};

/** The values of the edit form: settings, and which secrets are saved (never their values). */
export type ConnectionForm = {
  adapter: AdapterInfo;
  name: string;
  enabled: boolean;
  mode: ConnectionMode;
  settings: Record<string, unknown>;
  savedSecrets: string[];
};

export const CONNECTION_MODES = Object.keys(CONNECTION_MODE_LABELS) as ConnectionMode[];

export const connectionInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "This field is required.")
    .max(100, "Ensure this value has at most 100 characters."),
  enabled: z.boolean(),
  mode: z
    .enum(CONNECTION_MODES as [ConnectionMode, ...ConnectionMode[]], "Select a valid choice.")
    .optional(),
  /** Every non-secret field by name; the server validates them by the adapter's fields. */
  settings: z.record(z.string(), z.unknown()),
  /** New secret values; a missing or empty one keeps the saved value. */
  secrets: z.record(z.string(), z.string().max(100_000)),
});
export type ConnectionInput = z.input<typeof connectionInputSchema>;

/** A longer name is cut to 255 characters (the server does), as in the Django version. */
export const manualGroupSchema = z.object({ name: z.string().trim().min(1, "Enter a name.").max(10_000) });

// -- users and settings ----------------------------------------------------------------

export type UserRow = {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  roleSource: "local" | "provider";
  isActive: boolean;
  linked: boolean;
  person: Ref | null;
  lastLogin: string | null;
};

export const ROLES = Object.keys(ROLE_LABELS) as Role[];

export const userInputSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "This field is required.")
    .max(254, "Ensure this value has at most 254 characters.")
    .refine(isEmail, "Enter a valid email address."),
  displayName: trimmed(200),
  role: z.enum(ROLES as [Role, ...Role[]], "Select a valid choice."),
  isActive: z.boolean(),
  personId: idField,
});
export type UserInput = z.input<typeof userInputSchema>;

export type Settings = {
  organizationName: string;
  automaticOnboarding: boolean;
  onboardingLeadDays: number;
  automaticOffboarding: boolean;
  removalLimitPerDay: number;
  notificationEmails: string;
  /** The person types other apps may request (identity requests). Empty: none. */
  identityRequestTypes: PersonType[];
};

const count = z
  .number("Enter a whole number.")
  .int("Enter a whole number.")
  .min(0, "Ensure this value is greater than or equal to 0.")
  .max(2147483647, "Ensure this value is less than or equal to 2147483647.");

export const settingsInputSchema = z.object({
  organizationName: required(200),
  automaticOnboarding: z.boolean(),
  onboardingLeadDays: count,
  automaticOffboarding: z.boolean(),
  removalLimitPerDay: count,
  notificationEmails: z.string().max(100_000),
  identityRequestTypes: z
    .array(z.enum(PERSON_TYPES as [PersonType, ...PersonType[]], "Select a valid choice."))
    .max(PERSON_TYPES.length)
    // Stored in the order of the types, once each.
    .transform((types) => PERSON_TYPES.filter((type) => types.includes(type))),
});
export type SettingsInput = z.input<typeof settingsInputSchema>;

// -- identity requests and API keys ----------------------------------------------------

export type IdentityRequestRow = {
  id: number;
  name: string;
  personType: PersonType;
  status: IdentityRequestStatus;
  startDate: string | null;
  requestedBy: string;
  createdAt: string;
  person: Ref | null;
};

export type IdentityRequestDetail = IdentityRequestRow & {
  firstName: string;
  lastName: string;
  personalEmail: string;
  jobTitle: string;
  team: Ref | null;
  managerEmail: string;
  /** The person whose work email is the manager email, if any. */
  manager: Ref | null;
  endDate: string | null;
  notes: string;
  requestedByName: string;
  requestedByEmail: string;
  externalId: string;
  externalUrl: string;
  /** The API key the request came with. */
  source: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string;
  /** People who may be the same person: same personal or work email, or same name. */
  matches: (Ref & { status: PersonStatus; workEmail: string | null; reason: string })[];
  /** Other open or approved requests that may be for the same person (a hint, never a block). */
  duplicates: (Ref & {
    status: IdentityRequestStatus;
    source: string;
    createdAt: string;
    reason: string;
  })[];
};

export const rejectRequestSchema = z.object({
  reason: z.string().trim().min(1, "Say why, for the person who asked.").max(1000),
});

export const linkRequestSchema = z.object({
  personId: z.number("Select a person.").int().positive("Select a person."),
});

export type ApiKeyRow = {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export const apiKeyInputSchema = z.object({
  name: required(100),
});

/** A new key: `key` is shown this once. */
export type ApiKeyCreated = { key: string; apiKey: ApiKeyRow; message: string };

// -- the API for other apps (/api/integration/v1, with an API key) ------------------------

/** An http(s) URL, or empty. */
const linkField = z
  .string()
  .trim()
  .max(500, "Ensure this value has at most 500 characters.")
  .refine(
    (value) => value === "" || (/^https?:\/\//i.test(value) && URL.canParse(value)),
    "Enter a valid URL.",
  );

/** What another app sends to request a person (POST /api/integration/v1/identity-requests). */
export const identityRequestCreateSchema = z
  .object({
    /** The sender's reference, e.g. its ticket. Sending it again returns the same request. */
    externalId: required(255),
    externalUrl: linkField.default(""),
    requestedBy: z
      .object({ name: trimmed(200).default(""), email: emailField.default("") })
      .default({ name: "", email: "" }),
    firstName: required(150),
    lastName: required(150),
    personalEmail: emailField.default(""),
    jobTitle: trimmed(200).default(""),
    personType: z.enum(PERSON_TYPES as [PersonType, ...PersonType[]], "Select a valid choice."),
    teamId: idField,
    managerEmail: emailField.default(""),
    startDate: dateField,
    endDate: dateField,
    notes: z.string().trim().max(5000, "Ensure this value has at most 5000 characters.").default(""),
  })
  .superRefine((value, ctx) => {
    if (value.startDate && value.endDate && value.endDate < value.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "The last day cannot be before the start date.",
      });
    }
  });
export type IdentityRequestCreate = z.input<typeof identityRequestCreateSchema>;

/** A request as the sending app reads it back. */
export type IdentityRequestView = {
  id: number;
  externalId: string;
  status: IdentityRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Rejected: why. */
  reason: string;
  /** The request's page in IAM. */
  url: string;
  /** Approved: the person in IAM. */
  person: { status: PersonStatus; workEmail: string | null; startDate: string | null } | null;
};

/** The choices of a request form: the person types this installation accepts, and the teams. */
export type IdentityRequestOptions = {
  personTypes: { value: PersonType; label: string }[];
  teams: Ref[];
};
