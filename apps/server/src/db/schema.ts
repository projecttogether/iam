import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The data model. CONTEXT.md names each concept. Table, column, constraint
 * and index names are those of the Django version (0.1 and 0.2), so an
 * existing database is taken over in place (src/db/django.ts). Defaults are
 * set by the app, not the database, as before.
 */

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity();
const ref = (name: string) => bigint(name, { mode: "number" });
const stamp = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const now = () => new Date();

export const ROLES = ["viewer", "approver", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_SOURCES = ["local", "provider"] as const;
export type RoleSource = (typeof ROLE_SOURCES)[number];

export const PERSON_TYPES = ["employee", "intern", "freelancer", "volunteer", "external"] as const;
export type PersonType = (typeof PERSON_TYPES)[number];
export const PERSON_STATUSES = [
  "planned",
  "onboarding",
  "active",
  "offboarding",
  "offboarded",
  "archived",
] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const CONNECTION_MODES = ["automatic", "manual", "read_only"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];
export const CONNECTION_STATUSES = ["untested", "ok", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const ACCOUNT_STATUSES = ["active", "disabled", "missing", "unknown"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const WORKFLOW_KINDS = ["onboarding", "access_update", "offboarding"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];
export const WORKFLOW_STATUSES = ["running", "waiting", "completed", "failed", "cancelled"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const JOB_ACTIONS = ["ensure_account", "disable_account"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];
export const JOB_STATUSES = [
  "queued",
  "running",
  "held",
  "manual",
  "failed",
  "succeeded",
  "rehearsed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TASK_KINDS = ["change", "failure", "credentials"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ["open", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const IDENTITY_REQUEST_STATUSES = ["open", "approved", "rejected", "cancelled"] as const;
export type IdentityRequestStatus = (typeof IDENTITY_REQUEST_STATUSES)[number];

export const SYNC_KINDS = ["groups", "accounts", "people"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];
export const SYNC_STATUSES = ["running", "succeeded", "failed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Someone who may use this app. Sign-in proves who they are; this record decides what they may do. */
export const users = pgTable(
  "iam_user",
  {
    id: id(),
    /** The last sign-in, in this version or the Django version before. */
    lastLogin: stamp("last_login"),
    /** The last sign-in in this version: a later last_login comes from the Django version. */
    lastSessionAt: stamp("last_session_at"),
    email: varchar("email", { length: 254 }).notNull(),
    displayName: varchar("display_name", { length: 200 })
      .notNull()
      .$default(() => ""),
    oidcSubject: varchar("oidc_subject", { length: 255 }),
    role: varchar("role", { length: 20 })
      .$type<Role>()
      .notNull()
      .$default(() => "viewer"),
    roleSource: varchar("role_source", { length: 20 })
      .$type<RoleSource>()
      .notNull()
      .$default(() => "local"),
    isActive: boolean("is_active")
      .notNull()
      .$default(() => true),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    personId: ref("person_id"),
  },
  (t) => [
    unique("iam_user_email_key").on(t.email),
    unique("iam_user_oidc_subject_key").on(t.oidcSubject),
    unique("iam_user_person_id_key").on(t.personId),
    foreignKey({
      name: "iam_user_person_id_d3b34abb_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("set null"),
  ],
);

/** A browser session: the cookie holds the token, this row its SHA-256. */
export const sessions = pgTable(
  "iam_session",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: ref("user_id").notNull(),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    expiresAt: stamp("expires_at").notNull(),
    /** The provider's ID token: the hint of the provider's sign-out. */
    idToken: text("id_token")
      .notNull()
      .$default(() => ""),
  },
  (t) => [
    index("iam_session_user_id_idx").on(t.userId),
    index("iam_session_expires_at_idx").on(t.expiresAt),
    foreignKey({
      name: "iam_session_user_id_fk_iam_user_id",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

/** General settings an admin changes in Admin › Settings. One row (id 1). */
export const appSettings = pgTable(
  "iam_appsettings",
  {
    id: id(),
    organizationName: varchar("organization_name", { length: 200 })
      .notNull()
      .$default(() => "IAM"),
    onboardingLeadDays: integer("onboarding_lead_days")
      .notNull()
      .$default(() => 7),
    automaticOnboarding: boolean("automatic_onboarding")
      .notNull()
      .$default(() => true),
    automaticOffboarding: boolean("automatic_offboarding")
      .notNull()
      .$default(() => true),
    removalLimitPerDay: integer("removal_limit_per_day")
      .notNull()
      .$default(() => 5),
    notificationEmails: text("notification_emails")
      .notNull()
      .$default(() => ""),
    updatedAt: stamp("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    /**
     * The person types other apps may request through the API. Empty: no
     * identity requests. A database default, so the Django version still saves the row.
     */
    identityRequestTypes: jsonb("identity_request_types").$type<PersonType[]>().notNull().default([]),
  },
  (t) => [
    check("iam_appsettings_onboarding_lead_days_check", sql`${t.onboardingLeadDays} >= 0`),
    check("iam_appsettings_removal_limit_per_day_check", sql`${t.removalLimitPerDay} >= 0`),
  ],
);

/** One connected app or service, configured in Admin › Connections. */
export const connections = pgTable(
  "iam_connection",
  {
    id: id(),
    adapter: varchar("adapter", { length: 50 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    enabled: boolean("enabled")
      .notNull()
      .$default(() => false),
    mode: varchar("mode", { length: 20 })
      .$type<ConnectionMode>()
      .notNull()
      .$default(() => "automatic"),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .$default(() => ({})),
    secretData: text("secret_data")
      .notNull()
      .$default(() => ""),
    status: varchar("status", { length: 20 })
      .$type<ConnectionStatus>()
      .notNull()
      .$default(() => "untested"),
    statusMessage: text("status_message")
      .notNull()
      .$default(() => ""),
    checkedAt: stamp("checked_at"),
    groupsSyncedAt: stamp("groups_synced_at"),
    lastSyncAt: stamp("last_sync_at"),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    updatedAt: stamp("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
  },
  (t) => [unique("iam_connection_name_key").on(t.name)],
);

/** A group, role, channel or team in a connected app that access can grant. */
export const providerGroups = pgTable(
  "iam_providergroup",
  {
    id: id(),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    path: varchar("path", { length: 500 })
      .notNull()
      .$default(() => ""),
    description: text("description")
      .notNull()
      .$default(() => ""),
    /** A group the provider no longer lists. Kept so policy shows what broke. */
    missing: boolean("missing")
      .notNull()
      .$default(() => false),
    /** Added by hand, not imported. */
    manual: boolean("manual")
      .notNull()
      .$default(() => false),
    seenAt: stamp("seen_at"),
    connectionId: ref("connection_id").notNull(),
  },
  (t) => [
    unique("unique_group_per_connection").on(t.connectionId, t.externalId),
    index("iam_providergroup_connection_id_098a49d1").on(t.connectionId),
    foreignKey({
      name: "iam_providergroup_connection_id_098a49d1_fk_iam_connection_id",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
  ],
);

export const teams = pgTable(
  "iam_team",
  {
    id: id(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description")
      .notNull()
      .$default(() => ""),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
  },
  (t) => [unique("iam_team_name_key").on(t.name)],
);

/** Members join these groups in every app where their access profile gives them an account. */
export const teamGroups = pgTable(
  "iam_team_groups",
  {
    id: id(),
    teamId: ref("team_id").notNull(),
    providerGroupId: ref("providergroup_id").notNull(),
  },
  (t) => [
    unique("iam_team_groups_team_id_providergroup_id_37ba7dea_uniq").on(t.teamId, t.providerGroupId),
    index("iam_team_groups_providergroup_id_2d9a9706").on(t.providerGroupId),
    index("iam_team_groups_team_id_2a335e3c").on(t.teamId),
    foreignKey({
      name: "iam_team_groups_team_id_2a335e3c_fk_iam_team_id",
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_team_groups_providergroup_id_2d9a9706_fk_iam_provi",
      columns: [t.providerGroupId],
      foreignColumns: [providerGroups.id],
    }).onDelete("cascade"),
  ],
);

/** The accounts and groups a kind of person gets, e.g. "Staff" or "Volunteer". */
export const accessProfiles = pgTable(
  "iam_accessprofile",
  {
    id: id(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description")
      .notNull()
      .$default(() => ""),
    /** Person types that get this profile when added without one. */
    defaultFor: jsonb("default_for")
      .$type<string[]>()
      .notNull()
      .$default(() => []),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
  },
  (t) => [unique("iam_accessprofile_name_key").on(t.name)],
);

/** An account at one connection, with groups, that an access profile gives. */
export const profileGrants = pgTable(
  "iam_profilegrant",
  {
    id: id(),
    connectionId: ref("connection_id").notNull(),
    profileId: ref("profile_id").notNull(),
  },
  (t) => [
    unique("unique_grant_per_profile_connection").on(t.profileId, t.connectionId),
    index("iam_profilegrant_connection_id_6ca4f586").on(t.connectionId),
    index("iam_profilegrant_profile_id_87d29ab2").on(t.profileId),
    foreignKey({
      name: "iam_profilegrant_connection_id_6ca4f586_fk_iam_connection_id",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_profilegrant_profile_id_87d29ab2_fk_iam_accessprofile_id",
      columns: [t.profileId],
      foreignColumns: [accessProfiles.id],
    }).onDelete("cascade"),
  ],
);

export const profileGrantGroups = pgTable(
  "iam_profilegrant_groups",
  {
    id: id(),
    profileGrantId: ref("profilegrant_id").notNull(),
    providerGroupId: ref("providergroup_id").notNull(),
  },
  (t) => [
    unique("iam_profilegrant_groups_profilegrant_id_provider_64b1cb80_uniq").on(
      t.profileGrantId,
      t.providerGroupId,
    ),
    index("iam_profilegrant_groups_profilegrant_id_1a2a5090").on(t.profileGrantId),
    index("iam_profilegrant_groups_providergroup_id_3d0cf26d").on(t.providerGroupId),
    foreignKey({
      name: "iam_profilegrant_gro_profilegrant_id_1a2a5090_fk_iam_profi",
      columns: [t.profileGrantId],
      foreignColumns: [profileGrants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_profilegrant_gro_providergroup_id_3d0cf26d_fk_iam_provi",
      columns: [t.providerGroupId],
      foreignColumns: [providerGroups.id],
    }).onDelete("cascade"),
  ],
);

/** A person whose access this app manages. */
export const people = pgTable(
  "iam_person",
  {
    id: id(),
    firstName: varchar("first_name", { length: 150 }).notNull(),
    lastName: varchar("last_name", { length: 150 }).notNull(),
    workEmail: varchar("work_email", { length: 254 }),
    personalEmail: varchar("personal_email", { length: 254 })
      .notNull()
      .$default(() => ""),
    /** Login name in connected apps. Empty: the part of the work email before @. */
    username: varchar("username", { length: 150 })
      .notNull()
      .$default(() => ""),
    jobTitle: varchar("job_title", { length: 200 })
      .notNull()
      .$default(() => ""),
    personType: varchar("person_type", { length: 20 })
      .$type<PersonType>()
      .notNull()
      .$default(() => "employee"),
    status: varchar("status", { length: 20 })
      .$type<PersonStatus>()
      .notNull()
      .$default(() => "planned"),
    startDate: date("start_date", { mode: "string" }),
    /** Last working day. */
    endDate: date("end_date", { mode: "string" }),
    sourceId: varchar("source_id", { length: 255 })
      .notNull()
      .$default(() => ""),
    notes: text("notes")
      .notNull()
      .$default(() => ""),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    updatedAt: stamp("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    accessProfileId: ref("access_profile_id"),
    managerId: ref("manager_id"),
    /** The HR system this person was imported from. */
    sourceConnectionId: ref("source_connection_id"),
    teamId: ref("team_id"),
    /**
     * An approver cancelled the last onboarding: the schedule does not start
     * it again until the start date or the access profile changes.
     */
    onboardingPaused: boolean("onboarding_paused")
      .notNull()
      .$default(() => false),
  },
  (t) => [
    unique("iam_person_work_email_key").on(t.workEmail),
    uniqueIndex("unique_source_record")
      .on(t.sourceConnectionId, t.sourceId)
      .where(sql`NOT ((source_id)::text = ''::text)`),
    index("iam_person_access_profile_id_93aad4fd").on(t.accessProfileId),
    index("iam_person_manager_id_a46e499a").on(t.managerId),
    index("iam_person_source_connection_id_10d08115").on(t.sourceConnectionId),
    index("iam_person_start_d_7f8771_idx").on(t.startDate),
    index("iam_person_status_686ae9_idx").on(t.status),
    index("iam_person_team_id_bc86b57e").on(t.teamId),
    foreignKey({
      name: "iam_person_access_profile_id_93aad4fd_fk_iam_accessprofile_id",
      columns: [t.accessProfileId],
      foreignColumns: [accessProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "iam_person_manager_id_a46e499a_fk_iam_person_id",
      columns: [t.managerId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_person_source_connection_id_10d08115_fk_iam_connection_id",
      columns: [t.sourceConnectionId],
      foreignColumns: [connections.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_person_team_id_bc86b57e_fk_iam_team_id",
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete("set null"),
  ],
);

/** An account in a connected app, linked to a person or not (yet). */
export const accounts = pgTable(
  "iam_account",
  {
    id: id(),
    externalId: varchar("external_id", { length: 255 })
      .notNull()
      .$default(() => ""),
    username: varchar("username", { length: 255 })
      .notNull()
      .$default(() => ""),
    email: varchar("email", { length: 255 })
      .notNull()
      .$default(() => ""),
    displayName: varchar("display_name", { length: 255 })
      .notNull()
      .$default(() => ""),
    status: varchar("status", { length: 20 })
      .$type<AccountStatus>()
      .notNull()
      .$default(() => "unknown"),
    /** Group external IDs seen at the last observation; null when not observed. */
    observedGroups: jsonb("observed_groups").$type<string[] | null>(),
    /**
     * Groups this app put the account in. They stay managed for this account
     * after a profile or team stops using them, so an update can remove them.
     */
    appliedGroups: jsonb("applied_groups")
      .$type<string[]>()
      .notNull()
      .$default(() => []),
    observedAt: stamp("observed_at"),
    createdByApp: boolean("created_by_app")
      .notNull()
      .$default(() => false),
    updatedAt: stamp("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    connectionId: ref("connection_id").notNull(),
    personId: ref("person_id"),
  },
  (t) => [
    uniqueIndex("unique_account_external_id")
      .on(t.connectionId, t.externalId)
      .where(sql`NOT ((external_id)::text = ''::text)`),
    uniqueIndex("unique_account_per_person")
      .on(t.connectionId, t.personId)
      .where(sql`person_id IS NOT NULL`),
    index("iam_account_connection_id_97c73588").on(t.connectionId),
    index("iam_account_person_id_e89a8b35").on(t.personId),
    foreignKey({
      name: "iam_account_connection_id_97c73588_fk_iam_connection_id",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_account_person_id_e89a8b35_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("set null"),
  ],
);

/** One lifecycle change for one person: the jobs that carry out a desired-access snapshot. */
export const workflows = pgTable(
  "iam_workflow",
  {
    id: id(),
    kind: varchar("kind", { length: 20 }).$type<WorkflowKind>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<WorkflowStatus>()
      .notNull()
      .$default(() => "running"),
    desired: jsonb("desired")
      .$type<DesiredSnapshot>()
      .notNull()
      .$default(() => ({})),
    automatic: boolean("automatic")
      .notNull()
      .$default(() => false),
    reason: varchar("reason", { length: 300 })
      .notNull()
      .$default(() => ""),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    finishedAt: stamp("finished_at"),
    createdById: ref("created_by_id"),
    personId: ref("person_id").notNull(),
  },
  (t) => [
    index("iam_workflo_status_601a78_idx").on(t.status),
    index("iam_workflow_created_by_id_e953247f").on(t.createdById),
    index("iam_workflow_person_id_80a0b3c2").on(t.personId),
    foreignKey({
      name: "iam_workflow_created_by_id_e953247f_fk_iam_user_id",
      columns: [t.createdById],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_workflow_person_id_80a0b3c2_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
  ],
);

/** The JSON form of desired access a workflow keeps, by connection ID. */
export type DesiredSnapshot = Record<
  string,
  { connection: string; groups: string[]; group_names: Record<string, string> }
>;

/** One change at one connection, run by the worker or handed to a person. */
export const jobs = pgTable(
  "iam_job",
  {
    id: id(),
    action: varchar("action", { length: 30 }).$type<JobAction>().notNull(),
    groups: jsonb("groups")
      .$type<string[]>()
      .notNull()
      .$default(() => []),
    managedGroups: jsonb("managed_groups")
      .$type<string[]>()
      .notNull()
      .$default(() => []),
    status: varchar("status", { length: 20 })
      .$type<JobStatus>()
      .notNull()
      .$default(() => "queued"),
    attempts: integer("attempts")
      .notNull()
      .$default(() => 0),
    nextAttemptAt: stamp("next_attempt_at").notNull().$defaultFn(now),
    lockedUntil: stamp("locked_until"),
    lastError: text("last_error")
      .notNull()
      .$default(() => ""),
    result: jsonb("result")
      .$type<Record<string, unknown>>()
      .notNull()
      .$default(() => ({})),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    finishedAt: stamp("finished_at"),
    connectionId: ref("connection_id").notNull(),
    personId: ref("person_id").notNull(),
    workflowId: ref("workflow_id").notNull(),
    /** Set by each claim: only the worker holding the latest one settles the job. */
    claim: uuid("claim"),
  },
  (t) => [
    check("iam_job_attempts_check", sql`${t.attempts} >= 0`),
    index("iam_job_connection_id_11b003f1").on(t.connectionId),
    index("iam_job_person_id_b3dbe65b").on(t.personId),
    index("iam_job_status_a59e8f_idx").on(t.status, t.nextAttemptAt),
    index("iam_job_workflow_id_4ac591d1").on(t.workflowId),
    foreignKey({
      name: "iam_job_connection_id_11b003f1_fk_iam_connection_id",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_job_person_id_b3dbe65b_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_job_workflow_id_4ac591d1_fk_iam_workflow_id",
      columns: [t.workflowId],
      foreignColumns: [workflows.id],
    }).onDelete("cascade"),
  ],
);

/** Work a person does by hand: a change in an app without automation, or a job that needs help. */
export const tasks = pgTable(
  "iam_task",
  {
    id: id(),
    kind: varchar("kind", { length: 20 }).$type<TaskKind>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<TaskStatus>()
      .notNull()
      .$default(() => "open"),
    title: varchar("title", { length: 300 }).notNull(),
    instructions: text("instructions")
      .notNull()
      .$default(() => ""),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    completedAt: stamp("completed_at"),
    note: text("note")
      .notNull()
      .$default(() => ""),
    completedById: ref("completed_by_id"),
    connectionId: ref("connection_id"),
    jobId: ref("job_id"),
    personId: ref("person_id"),
  },
  (t) => [
    uniqueIndex("one_open_task_per_job_and_kind")
      .on(t.jobId, t.kind)
      .where(sql`((job_id IS NOT NULL) AND ((status)::text = 'open'::text))`),
    index("iam_task_completed_by_id_d213b18c").on(t.completedById),
    index("iam_task_connection_id_cac61973").on(t.connectionId),
    index("iam_task_job_id_aa6d8855").on(t.jobId),
    index("iam_task_person_id_e52d665b").on(t.personId),
    index("iam_task_status_fef816_idx").on(t.status),
    foreignKey({
      name: "iam_task_completed_by_id_d213b18c_fk_iam_user_id",
      columns: [t.completedById],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_task_connection_id_cac61973_fk_iam_connection_id",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_task_job_id_aa6d8855_fk_iam_job_id",
      columns: [t.jobId],
      foreignColumns: [jobs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_task_person_id_e52d665b_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("cascade"),
  ],
);

/** A read from a connection: group import, account comparison, people import. */
export const syncRuns = pgTable(
  "iam_syncrun",
  {
    id: id(),
    kind: varchar("kind", { length: 20 }).$type<SyncKind>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<SyncStatus>()
      .notNull()
      .$default(() => "running"),
    summary: jsonb("summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .$default(() => ({})),
    error: text("error")
      .notNull()
      .$default(() => ""),
    startedAt: stamp("started_at").notNull().$defaultFn(now),
    finishedAt: stamp("finished_at"),
    connectionId: ref("connection_id").notNull(),
    triggeredById: ref("triggered_by_id"),
  },
  (t) => [
    index("iam_syncrun_connection_id_baed4fc7").on(t.connectionId),
    index("iam_syncrun_triggered_by_id_94029f09").on(t.triggeredById),
    foreignKey({
      name: "iam_syncrun_connection_id_baed4fc7_fk_iam_connection_id",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "iam_syncrun_triggered_by_id_94029f09_fk_iam_user_id",
      columns: [t.triggeredById],
      foreignColumns: [users.id],
    }).onDelete("set null"),
  ],
);

/** Append-only record of who changed what. Never holds secret values. */
export const auditEvents = pgTable(
  "iam_auditevent",
  {
    id: id(),
    actorLabel: varchar("actor_label", { length: 255 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    targetType: varchar("target_type", { length: 50 })
      .notNull()
      .$default(() => ""),
    targetId: varchar("target_id", { length: 50 })
      .notNull()
      .$default(() => ""),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .$default(() => ({})),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    actorId: ref("actor_id"),
    personId: ref("person_id"),
  },
  (t) => [
    index("iam_auditevent_actor_id_dca8973b").on(t.actorId),
    index("iam_auditevent_created_at_a9b4638f").on(t.createdAt),
    index("iam_auditevent_person_id_1b28b0b7").on(t.personId),
    foreignKey({
      name: "iam_auditevent_actor_id_dca8973b_fk_iam_user_id",
      columns: [t.actorId],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_auditevent_person_id_1b28b0b7_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("set null"),
  ],
);

/**
 * A key another app (e.g. Helpdesk) uses for the API of identity
 * requests. The key is shown once; this row keeps its SHA-256 and its prefix.
 */
export const apiKeys = pgTable(
  "iam_apikey",
  {
    id: id(),
    name: varchar("name", { length: 100 }).notNull(),
    /** The first characters of the key, to tell keys apart. */
    prefix: varchar("prefix", { length: 20 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    lastUsedAt: stamp("last_used_at"),
    revokedAt: stamp("revoked_at"),
    createdById: ref("created_by_id"),
    /** Created with the operator command, so by no user. */
    createdByOperator: boolean("created_by_operator").notNull().default(false),
  },
  (t) => [
    unique("iam_apikey_key_hash_key").on(t.keyHash),
    foreignKey({
      name: "iam_apikey_created_by_id_fk_iam_user_id",
      columns: [t.createdById],
      foreignColumns: [users.id],
    }).onDelete("set null"),
  ],
);

/**
 * A request from another app to add a person. An approver creates the
 * person from it, links it to a person already here, or rejects it; the
 * app that sent it reads the outcome through the API.
 */
export const identityRequests = pgTable(
  "iam_identityrequest",
  {
    id: id(),
    status: varchar("status", { length: 20 })
      .$type<IdentityRequestStatus>()
      .notNull()
      .$default(() => "open"),
    /** The sending app's reference, e.g. its ticket: one request per reference. */
    externalId: varchar("external_id", { length: 255 }).notNull(),
    externalUrl: varchar("external_url", { length: 500 })
      .notNull()
      .$default(() => ""),
    /**
     * SHA-256 of what was sent, so a resend of the reference with other
     * details is refused instead of silently answered with the first request.
     */
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull().default(""),
    /** Who asked, as the sending app states it. */
    requestedByName: varchar("requested_by_name", { length: 200 })
      .notNull()
      .$default(() => ""),
    requestedByEmail: varchar("requested_by_email", { length: 254 })
      .notNull()
      .$default(() => ""),
    firstName: varchar("first_name", { length: 150 }).notNull(),
    lastName: varchar("last_name", { length: 150 }).notNull(),
    personalEmail: varchar("personal_email", { length: 254 })
      .notNull()
      .$default(() => ""),
    jobTitle: varchar("job_title", { length: 200 })
      .notNull()
      .$default(() => ""),
    personType: varchar("person_type", { length: 20 }).$type<PersonType>().notNull(),
    teamId: ref("team_id"),
    /** The manager's work email; the approval form looks up the person. */
    managerEmail: varchar("manager_email", { length: 254 })
      .notNull()
      .$default(() => ""),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    notes: text("notes")
      .notNull()
      .$default(() => ""),
    createdAt: stamp("created_at").notNull().$defaultFn(now),
    updatedAt: stamp("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    decidedAt: stamp("decided_at"),
    /** Why it was rejected. */
    decisionNote: text("decision_note")
      .notNull()
      .$default(() => ""),
    decidedById: ref("decided_by_id"),
    apiKeyId: ref("api_key_id"),
    /** The person created from the request, or linked to it. */
    personId: ref("person_id"),
  },
  (t) => [
    unique("iam_identityrequest_external_id_key").on(t.externalId),
    index("iam_identityrequest_status_idx").on(t.status),
    index("iam_identityrequest_person_id_idx").on(t.personId),
    foreignKey({
      name: "iam_identityrequest_team_id_fk_iam_team_id",
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_identityrequest_decided_by_id_fk_iam_user_id",
      columns: [t.decidedById],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_identityrequest_api_key_id_fk_iam_apikey_id",
      columns: [t.apiKeyId],
      foreignColumns: [apiKeys.id],
    }).onDelete("set null"),
    foreignKey({
      name: "iam_identityrequest_person_id_fk_iam_person_id",
      columns: [t.personId],
      foreignColumns: [people.id],
    }).onDelete("set null"),
  ],
);

/** When the worker last finished a loop. */
export const workerHeartbeats = pgTable("iam_workerheartbeat", {
  name: varchar("name", { length: 50 }).primaryKey(),
  beatAt: stamp("beat_at").notNull().$defaultFn(now),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type ProviderGroup = typeof providerGroups.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type AccessProfile = typeof accessProfiles.$inferSelect;
export type ProfileGrant = typeof profileGrants.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type IdentityRequest = typeof identityRequests.$inferSelect;
