import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { identityRequestCreateSchema, IdentityRequestView } from "@iam/shared/api/iam";
import { PERSON_TYPE_LABELS } from "@iam/shared/labels";
import { config } from "../config";
import {
  apiKeys,
  identityRequests,
  people,
  teams,
  type ApiKey,
  type IdentityRequest,
  type User,
} from "../db/schema";
import { atomic, onCommit, q } from "../db/tx";
import { runInBackground } from "../core/background";
import { AppError, conflict, notFound, validationError } from "../http/errors";
import { record } from "./audit";
import { sendEmail } from "./email";
import { fullName } from "./people";
import { loadSettings, notificationRecipients } from "./settings";
import { logger } from "../logger";

/**
 * Identity requests: other apps ask for a person through the API
 * (/api/integration/v1) with an API key; an approver creates the person,
 * links a person already here, or rejects the request. Only the person
 * types chosen in Admin › Settings can be requested.
 */

// -- API keys --------------------------------------------------------------------------

const KEY_PREFIX = "iam_";
const KEY_PATTERN = /^iam_[A-Za-z0-9_-]{43}$/;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new key (`iam_` and 32 random bytes), the prefix to show, and the hash to store. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

/** The key of an `Authorization: Bearer iam_…` header, if it exists and is not revoked. */
export async function apiKeyFrom(header: string | undefined): Promise<ApiKey | null> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!match || !KEY_PATTERN.test(match[1]!)) return null;
  const [key] = await q()
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashApiKey(match[1]!)), isNull(apiKeys.revokedAt)));
  if (!key) return null;
  // At most one write a minute per key.
  await q()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, key.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(Date.now() - 60_000))),
      ),
    );
  return key;
}

/** How the audit log names a key's actions. */
export const keyLabel = (key: Pick<ApiKey, "name">) => `API key "${key.name}"`;

// -- requests --------------------------------------------------------------------------

export const requestName = (request: Pick<IdentityRequest, "firstName" | "lastName">) =>
  `${request.firstName} ${request.lastName}`.trim();

export const requestUrl = (id: number) => `${config().APP_URL.replace(/\/+$/, "")}/requests/${id}`;

/** The request as the sending app reads it. */
export async function requestView(request: IdentityRequest): Promise<IdentityRequestView> {
  const [person] =
    request.personId === null ? [] : await q().select().from(people).where(eq(people.id, request.personId));
  return {
    id: request.id,
    externalId: request.externalId,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    reason: request.status === "rejected" ? request.decisionNote : "",
    url: requestUrl(request.id),
    person: person
      ? { status: person.status, workEmail: person.workEmail, startDate: person.startDate }
      : null,
  };
}

type CreateInput = z.output<typeof identityRequestCreateSchema>;

/** Lower-case plural of a type for messages, e.g. "interns". */
const typePlural = (type: CreateInput["personType"]) => `${PERSON_TYPE_LABELS[type].toLowerCase()}s`;

/** JSON with sorted keys: the same details give the same text. */
function canonical(value: unknown): string {
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The fingerprint of a request's details, after validation (trimmed,
 * defaults filled in), with every email address lower-cased for the
 * fingerprint only: capitals in an address make no other request.
 */
function requestFingerprint(input: CreateInput): string {
  const normalized = {
    ...input,
    personalEmail: input.personalEmail.toLowerCase(),
    managerEmail: input.managerEmail.toLowerCase(),
    requestedBy: { ...input.requestedBy, email: input.requestedBy.email.toLowerCase() },
  };
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

/**
 * The request stored for this reference. A resend with the same details is
 * answered with it; other details under the same reference are refused, so
 * the sender never believes IAM holds what it does not.
 */
function sameRequest(request: IdentityRequest, fingerprint: string): IdentityRequest {
  if (request.requestFingerprint && request.requestFingerprint !== fingerprint) {
    throw conflict(
      "This reference was already used for a request with other details. Send changes as a new request.",
      "reference_reused",
    );
  }
  return request;
}

/**
 * Stores a request from another app. The same `externalId` with the same
 * details returns the request stored first (`created: false`), whatever the
 * settings now say; with other details it is refused (409 reference_reused).
 */
export async function receiveRequest(
  input: CreateInput,
  key: ApiKey,
): Promise<{ request: IdentityRequest; created: boolean }> {
  const fingerprint = requestFingerprint(input);
  const existing = async () =>
    (await q().select().from(identityRequests).where(eq(identityRequests.externalId, input.externalId)))[0];
  const first = await existing();
  if (first) return { request: sameRequest(first, fingerprint), created: false };

  const allowed = (await loadSettings()).identityRequestTypes;
  if (allowed.length === 0) {
    throw new AppError(403, "identity_requests_off", "This installation accepts no identity requests.");
  }
  if (!allowed.includes(input.personType)) {
    throw validationError({
      personType: `This installation accepts no identity requests for ${typePlural(input.personType)}.`,
    });
  }
  if (input.teamId !== null) {
    const [team] = await q().select({ id: teams.id }).from(teams).where(eq(teams.id, input.teamId));
    if (!team) {
      throw validationError({
        teamId: "Select a valid choice. That choice is not one of the available choices.",
      });
    }
  }

  return atomic(async () => {
    const [created] = await q()
      .insert(identityRequests)
      .values({
        externalId: input.externalId,
        externalUrl: input.externalUrl,
        requestFingerprint: fingerprint,
        requestedByName: input.requestedBy.name,
        requestedByEmail: input.requestedBy.email.toLowerCase(),
        firstName: input.firstName,
        lastName: input.lastName,
        personalEmail: input.personalEmail,
        jobTitle: input.jobTitle,
        personType: input.personType,
        teamId: input.teamId,
        managerEmail: input.managerEmail.toLowerCase(),
        startDate: input.startDate,
        endDate: input.endDate,
        notes: input.notes,
        apiKeyId: key.id,
      })
      .onConflictDoNothing({ target: identityRequests.externalId })
      .returning();
    // Sent twice at once: the other one stored it.
    if (!created) return { request: sameRequest((await existing())!, fingerprint), created: false };
    await record("identity_request.received", `Received an identity request for ${requestName(created)}`, {
      actorLabel: keyLabel(key),
      target: { type: "identityrequest", id: created.id },
      details: { person_type: created.personType, external_id: created.externalId },
    });
    // Not awaited: a slow mail server must not hold up the sending app's answer. A stop
    // waits for it (core/background.ts).
    onCommit(() => {
      runInBackground(() =>
        notifyRequest(created).catch((error: unknown) =>
          logger.warn({ err: error, requestId: created.id }, "identity request email failed"),
        ),
      );
    });
    return { request: created, created: true };
  });
}

/** Tells the notification addresses about a new request; best effort. */
async function notifyRequest(request: IdentityRequest): Promise<void> {
  const recipients = notificationRecipients(await loadSettings());
  if (recipients.length === 0) return;
  const lines = [
    `New identity request in IAM: ${requestName(request)} (${PERSON_TYPE_LABELS[request.personType]}).`,
    "",
    `Review it: ${requestUrl(request.id)}`,
  ];
  await sendEmail(recipients, "New identity request in IAM", lines.join("\n"));
}

/** The request, locked for a decision; 404 when unknown. */
async function lockRequest(id: number): Promise<IdentityRequest> {
  const [request] = await q()
    .select()
    .from(identityRequests)
    .where(eq(identityRequests.id, id))
    .for("update");
  if (!request) throw notFound();
  return request;
}

function requireOpen(request: IdentityRequest): void {
  if (request.status !== "open") {
    throw conflict(`This request is already ${request.status}.`, "request_closed");
  }
}

/** The sending app withdraws a request. Cancelling twice is fine; a decided request stays. */
export async function cancelRequest(id: number, key: ApiKey): Promise<IdentityRequest> {
  return atomic(async () => {
    const request = await lockRequest(id);
    if (request.status === "cancelled") return request;
    if (request.status !== "open") {
      throw conflict(
        `This request is already ${request.status}. Ask the people who manage access to change it.`,
        "request_closed",
      );
    }
    const [saved] = await q()
      .update(identityRequests)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(eq(identityRequests.id, id))
      .returning();
    await record("identity_request.cancelled", `Cancelled the identity request for ${requestName(saved!)}`, {
      actorLabel: keyLabel(key),
      target: { type: "identityrequest", id },
    });
    return saved!;
  });
}

/**
 * Closes an open request with a person: `addPerson` runs in the same
 * transaction, so the request is approved exactly when the person is saved.
 */
export async function approveRequest(
  id: number,
  actor: User,
  person: () => Promise<{ id: number; firstName: string; lastName: string }>,
  linked: boolean,
): Promise<IdentityRequest> {
  return atomic(async () => {
    const request = await lockRequest(id);
    requireOpen(request);
    const chosen = await person();
    const [saved] = await q()
      .update(identityRequests)
      .set({ status: "approved", decidedAt: new Date(), decidedById: actor.id, personId: chosen.id })
      .where(eq(identityRequests.id, id))
      .returning();
    await record(
      linked ? "identity_request.linked" : "identity_request.approved",
      linked
        ? `Linked the identity request for ${requestName(request)} to ${fullName(chosen)}`
        : `Approved the identity request for ${requestName(request)}`,
      { actor, personId: chosen.id, target: { type: "identityrequest", id } },
    );
    return saved!;
  });
}

export async function rejectRequest(id: number, actor: User, reason: string): Promise<IdentityRequest> {
  return atomic(async () => {
    const request = await lockRequest(id);
    requireOpen(request);
    const [saved] = await q()
      .update(identityRequests)
      .set({ status: "rejected", decidedAt: new Date(), decidedById: actor.id, decisionNote: reason })
      .where(eq(identityRequests.id, id))
      .returning();
    await record("identity_request.rejected", `Rejected the identity request for ${requestName(request)}`, {
      actor,
      target: { type: "identityrequest", id },
    });
    return saved!;
  });
}

/** People who may be the person of a request: same personal or work email, or same name. */
export async function possibleMatches(request: IdentityRequest) {
  const email = request.personalEmail.toLowerCase();
  const rows = await q()
    .select()
    .from(people)
    .where(
      or(
        email ? sql`lower(${people.personalEmail}) = ${email}` : undefined,
        email ? sql`lower(${people.workEmail}) = ${email}` : undefined,
        and(
          sql`lower(${people.firstName}) = ${request.firstName.toLowerCase()}`,
          sql`lower(${people.lastName}) = ${request.lastName.toLowerCase()}`,
        ),
      ),
    )
    .orderBy(people.lastName, people.firstName, people.id)
    .limit(10);
  return rows.map((person) => ({
    id: person.id,
    name: fullName(person),
    status: person.status,
    workEmail: person.workEmail,
    reason:
      email && person.personalEmail.toLowerCase() === email
        ? "Same personal email"
        : email && (person.workEmail ?? "").toLowerCase() === email
          ? "Work email is the requested personal email"
          : "Same name",
  }));
}

/**
 * Other requests that may be for the same person: open or approved ones
 * with the same personal email, or the same name and start date. A hint for
 * approvers (two people can share a name), never a block.
 */
export async function possibleDuplicates(request: IdentityRequest) {
  const email = request.personalEmail.trim();
  // Without an email or a start date, nothing marks a duplicate.
  if (!email && !request.startDate) return [];
  const sameEmail = email
    ? sql<boolean>`lower(${identityRequests.personalEmail}) = lower(${email})`
    : sql<boolean>`false`;
  const sameNameAndStart = request.startDate
    ? and(
        sql`lower(${identityRequests.firstName}) = lower(${request.firstName})`,
        sql`lower(${identityRequests.lastName}) = lower(${request.lastName})`,
        eq(identityRequests.startDate, request.startDate),
      )
    : sql<boolean>`false`;
  const rows = await q()
    .select({ request: identityRequests, key: apiKeys.name, sameEmail })
    .from(identityRequests)
    .leftJoin(apiKeys, eq(apiKeys.id, identityRequests.apiKeyId))
    .where(
      and(
        ne(identityRequests.id, request.id),
        inArray(identityRequests.status, ["open", "approved"]),
        or(sameEmail, sameNameAndStart),
      ),
    )
    .orderBy(desc(identityRequests.createdAt), desc(identityRequests.id))
    .limit(10);
  return rows.map(({ request: other, key, sameEmail: emailMatches }) => ({
    id: other.id,
    name: requestName(other),
    status: other.status,
    source: key ?? "",
    createdAt: other.createdAt.toISOString(),
    reason: emailMatches ? "Same personal email" : "Same name and start date",
  }));
}
