/**
 * The values of the app's choices and their labels, as the Django version
 * named them. The server writes texts with them; the web app shows them.
 */

export const ROLE_LABELS = { viewer: "Viewer", approver: "Approver", admin: "Admin" } as const;
export type Role = keyof typeof ROLE_LABELS;
export const ROLE_RANK: Record<Role, number> = { viewer: 1, approver: 2, admin: 3 };

export const ROLE_SOURCE_LABELS = {
  local: "Set in this app",
  provider: "Group claim of the sign-in provider",
} as const;

export const PERSON_TYPE_LABELS = {
  employee: "Employee",
  intern: "Intern",
  freelancer: "Freelancer",
  volunteer: "Volunteer",
  external: "External",
} as const;
export type PersonType = keyof typeof PERSON_TYPE_LABELS;

export const PERSON_STATUS_LABELS = {
  planned: "Planned",
  onboarding: "Onboarding",
  active: "Active",
  offboarding: "Offboarding",
  offboarded: "Offboarded",
  archived: "Archived",
} as const;
export type PersonStatus = keyof typeof PERSON_STATUS_LABELS;

export const CONNECTION_MODE_LABELS = {
  automatic: "Automatic: the app makes the changes",
  manual: "Manual: the app creates tasks for each change",
  read_only: "Read only: compare, never change",
} as const;
export type ConnectionMode = keyof typeof CONNECTION_MODE_LABELS;

export const CONNECTION_STATUS_LABELS = { untested: "Not tested", ok: "Connected", error: "Error" } as const;
export type ConnectionStatus = keyof typeof CONNECTION_STATUS_LABELS;

export const ACCOUNT_STATUS_LABELS = {
  active: "Active",
  disabled: "Disabled",
  missing: "Not found",
  unknown: "Unknown",
} as const;
export type AccountStatus = keyof typeof ACCOUNT_STATUS_LABELS;

export const WORKFLOW_KIND_LABELS = {
  onboarding: "Onboarding",
  access_update: "Access update",
  offboarding: "Offboarding",
} as const;
export type WorkflowKind = keyof typeof WORKFLOW_KIND_LABELS;

export const WORKFLOW_STATUS_LABELS = {
  running: "Running",
  waiting: "Waiting for people",
  completed: "Completed",
  failed: "Needs attention",
  cancelled: "Cancelled",
} as const;
export type WorkflowStatus = keyof typeof WORKFLOW_STATUS_LABELS;

export const JOB_ACTION_LABELS = {
  ensure_account: "Create or update account",
  disable_account: "Disable account",
} as const;
export type JobAction = keyof typeof JOB_ACTION_LABELS;

export const JOB_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  held: "Waiting for approval",
  manual: "Manual task open",
  failed: "Failed",
  succeeded: "Done",
  rehearsed: "Checked only (read-only mode)",
  cancelled: "Cancelled",
} as const;
export type JobStatus = keyof typeof JOB_STATUS_LABELS;

export const TASK_KIND_LABELS = {
  change: "Make a change",
  failure: "Fix a failed change",
  credentials: "Hand over sign-in details",
} as const;
export type TaskKind = keyof typeof TASK_KIND_LABELS;

export const TASK_STATUS_LABELS = { open: "Open", done: "Done", cancelled: "Cancelled" } as const;
export type TaskStatus = keyof typeof TASK_STATUS_LABELS;

export const IDENTITY_REQUEST_STATUS_LABELS = {
  open: "Open",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
} as const;
export type IdentityRequestStatus = keyof typeof IDENTITY_REQUEST_STATUS_LABELS;

export const SYNC_KIND_LABELS = {
  groups: "Group import",
  accounts: "Account comparison",
  people: "People import",
} as const;
export type SyncKind = keyof typeof SYNC_KIND_LABELS;

export const SYNC_STATUS_LABELS = { running: "Running", succeeded: "Succeeded", failed: "Failed" } as const;
export type SyncStatus = keyof typeof SYNC_STATUS_LABELS;

export const ADAPTER_KIND_LABELS = {
  provisioning: "Accounts and groups",
  hr_source: "People import",
  email: "Email",
} as const;
export type AdapterKind = keyof typeof ADAPTER_KIND_LABELS;

/** Statuses in which a workflow still needs something. */
export const OPEN_WORKFLOW_STATUSES = [
  "running",
  "waiting",
  "failed",
] as const satisfies readonly WorkflowStatus[];
/** Statuses in which a job still needs something. */
export const OPEN_JOB_STATUSES = [
  "queued",
  "running",
  "held",
  "manual",
  "failed",
] as const satisfies readonly JobStatus[];
/** Nothing more happens to a job in one of these. */
export const FINISHED_JOB_STATUSES = [
  "succeeded",
  "rehearsed",
  "cancelled",
] as const satisfies readonly JobStatus[];

/** The tone of a status badge. */
export type Tone = "ok" | "info" | "warn" | "danger" | "neutral";
const TONES: Record<Exclude<Tone, "neutral">, string[]> = {
  ok: ["active", "succeeded", "completed", "done", "ok", "approved"],
  info: ["onboarding", "running", "queued", "planned", "untested", "unknown", "rehearsed"],
  warn: ["held", "manual", "waiting", "offboarding", "open", "missing"],
  danger: ["failed", "error"],
};

export function toneOf(value: string): Tone {
  for (const [tone, values] of Object.entries(TONES)) if (values.includes(value)) return tone as Tone;
  return "neutral";
}
