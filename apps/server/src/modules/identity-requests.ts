import { Hono } from "hono";
import type { z } from "zod";
import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  apiKeyInputSchema,
  linkRequestSchema,
  personInputSchema,
  rejectRequestSchema,
  type ApiKeyCreated,
  type ApiKeyRow,
  type IdentityRequestDetail,
  type IdentityRequestRow,
} from "@iam/shared/api/iam";
import { IDENTITY_REQUEST_STATUS_LABELS, type IdentityRequestStatus } from "@iam/shared/labels";
import {
  apiKeys,
  identityRequests,
  people,
  teams,
  users,
  type ApiKey,
  type IdentityRequest,
  type User,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, requireRole } from "../http/middleware";
import { conflict, notFound, validationError } from "../http/errors";
import { isOperator, record, type Actor } from "../engine/audit";
import { fullName } from "../engine/people";
import {
  approveRequest,
  newApiKey,
  possibleDuplicates,
  possibleMatches,
  rejectRequest,
  requestName,
} from "../engine/identity-requests";
import { addPerson, cleanPerson } from "./people";
import { countOf, iso, pageNumber, paginate } from "./rows";

/** Identity requests (everyone reads, approvers decide) and the API keys other apps send them with (admins). */
const router = new Hono<AppEnv>();
const PER_PAGE = 50;

const STATUSES = Object.keys(IDENTITY_REQUEST_STATUS_LABELS) as IdentityRequestStatus[];

function row(request: IdentityRequest, person: { id: number; firstName: string; lastName: string } | null) {
  return {
    id: request.id,
    name: requestName(request),
    personType: request.personType,
    status: request.status,
    startDate: request.startDate,
    requestedBy: request.requestedByName || request.requestedByEmail,
    createdAt: request.createdAt.toISOString(),
    person: person ? { id: person.id, name: fullName(person) } : null,
  } satisfies IdentityRequestRow;
}

/** `?status=` (default open; `all` for every request) and `?page=`. */
router.get("/identity-requests", async (c) => {
  requireRole(c, "viewer");
  const status = c.req.query("status") ?? "open";
  const where: SQL | undefined = STATUSES.includes(status as IdentityRequestStatus)
    ? eq(identityRequests.status, status as IdentityRequestStatus)
    : undefined;
  const total = await countOf(identityRequests, where);
  const page = await paginate<IdentityRequestRow>(
    total,
    pageNumber(c.req.query("page")),
    PER_PAGE,
    async (limit, offset) => {
      const rows = await q()
        .select({ request: identityRequests, person: people })
        .from(identityRequests)
        .leftJoin(people, eq(people.id, identityRequests.personId))
        .where(where)
        .orderBy(desc(identityRequests.createdAt), desc(identityRequests.id))
        .limit(limit)
        .offset(offset);
      return rows.map(({ request, person }) => row(request, person));
    },
  );
  return c.json(page);
});

async function requestOr404(id: number): Promise<IdentityRequest> {
  const [request] = await q().select().from(identityRequests).where(eq(identityRequests.id, id));
  if (!request) throw notFound();
  return request;
}

router.get("/identity-requests/:id", async (c) => {
  requireRole(c, "viewer");
  const request = await requestOr404(idParam(c));
  const one = async <T>(rows: Promise<T[]>) => (await rows)[0] ?? null;
  const person =
    request.personId === null
      ? null
      : await one(q().select().from(people).where(eq(people.id, request.personId)));
  const team =
    request.teamId === null
      ? null
      : await one(
          q().select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, request.teamId)),
        );
  const manager = request.managerEmail
    ? await one(
        q()
          .select()
          .from(people)
          // As the person form: an archived person is no manager.
          .where(
            and(
              sql`lower(${people.workEmail}) = ${request.managerEmail.toLowerCase()}`,
              ne(people.status, "archived"),
            ),
          )
          .limit(1),
      )
    : null;
  const key =
    request.apiKeyId === null
      ? null
      : await one(q().select().from(apiKeys).where(eq(apiKeys.id, request.apiKeyId)));
  const decidedBy =
    request.decidedById === null
      ? null
      : await one(q().select().from(users).where(eq(users.id, request.decidedById)));
  const body: IdentityRequestDetail = {
    ...row(request, person),
    firstName: request.firstName,
    lastName: request.lastName,
    personalEmail: request.personalEmail,
    jobTitle: request.jobTitle,
    team,
    managerEmail: request.managerEmail,
    manager: manager ? { id: manager.id, name: fullName(manager) } : null,
    endDate: request.endDate,
    notes: request.notes,
    requestedByName: request.requestedByName,
    requestedByEmail: request.requestedByEmail,
    externalId: request.externalId,
    externalUrl: request.externalUrl,
    source: key ? key.name : "",
    decidedAt: iso(request.decidedAt),
    decidedBy: decidedBy ? decidedBy.displayName || decidedBy.email : null,
    decisionNote: request.decisionNote,
    matches: request.status === "open" ? await possibleMatches(request) : [],
    duplicates: request.status === "open" ? await possibleDuplicates(request) : [],
  };
  return c.json(body);
});

/** Creates the person from the person form (prefilled from the request) and approves the request. */
router.post("/identity-requests/:id/approve", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  const input = await jsonBody(c, personInputSchema);
  let personId = 0;
  await approveRequest(
    id,
    user,
    async () => {
      const person = await addPerson(await cleanPerson(input, null), user);
      personId = person.id;
      return person;
    },
    false,
  );
  return c.json({ id: personId, message: `Added ${input.firstName} ${input.lastName}.` });
});

/** Approves the request with a person already in this app. */
router.post("/identity-requests/:id/link", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  const { personId } = await jsonBody(c, linkRequestSchema);
  await approveRequest(
    id,
    user,
    async () => {
      const [person] = await q().select().from(people).where(eq(people.id, personId));
      if (!person) throw validationError({ personId: "Select a valid person." });
      return person;
    },
    true,
  );
  return c.json({ id: personId, message: "Linked the request to the person." });
});

router.post("/identity-requests/:id/reject", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  const { reason } = await jsonBody(c, rejectRequestSchema);
  await rejectRequest(id, user, reason);
  return c.json({ id, message: "Rejected the request." });
});

// -- API keys (admins) -----------------------------------------------------------------

/** Every API key, newest first (GET /api-keys, `cli tokens list`). */
export async function keyRows(where?: SQL): Promise<ApiKeyRow[]> {
  const rows = await q()
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdById))
    .where(where)
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(({ key, user }) => keyRow(key, user));
}

function keyRow(key: ApiKey, user: Pick<User, "displayName" | "email"> | null): ApiKeyRow {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    createdBy: key.createdByOperator ? "Operator" : user ? user.displayName || user.email : null,
    lastUsedAt: iso(key.lastUsedAt),
    revokedAt: iso(key.revokedAt),
  };
}

router.get("/api-keys", async (c) => {
  requireRole(c, "admin");
  return c.json(await keyRows());
});

/** Creates an API key (POST /api-keys, `cli tokens create api-key`); `key` is the only copy. */
export async function createApiKey(
  actor: Actor,
  { name }: z.infer<typeof apiKeyInputSchema>,
): Promise<ApiKeyCreated> {
  const { key, prefix, hash } = newApiKey();
  const user = isOperator(actor) ? null : actor;
  const created = await atomic(async () => {
    const [saved] = await q()
      .insert(apiKeys)
      .values({ name, prefix, keyHash: hash, createdById: user?.id ?? null, createdByOperator: !user })
      .returning();
    await record("api_key.created", `Created the API key "${name}"`, {
      actor,
      target: { type: "apikey", id: saved!.id },
      details: { prefix },
    });
    return saved!;
  });
  return {
    key,
    apiKey: keyRow(created, user),
    message: "Created the key. Copy it now: it is shown only once.",
  };
}

router.post("/api-keys", async (c) => {
  const user = requireRole(c, "admin");
  const input = await jsonBody(c, apiKeyInputSchema);
  return c.json(await createApiKey(user, input), 201);
});

/** Revokes an API key (POST /api-keys/:id/revoke, `cli tokens revoke`). */
export async function revokeApiKey(actor: Actor, id: number): Promise<{ id: number; message: string }> {
  const name = await atomic(async () => {
    const [revoked] = await q()
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning();
    if (!revoked) {
      const [existing] = await q().select().from(apiKeys).where(eq(apiKeys.id, id));
      if (!existing) throw notFound();
      throw conflict("This key is already revoked.");
    }
    await record("api_key.revoked", `Revoked the API key "${revoked.name}"`, {
      actor,
      target: { type: "apikey", id },
    });
    return revoked.name;
  });
  return { id, message: `Revoked the key "${name}".` };
}

router.post("/api-keys/:id/revoke", async (c) => {
  const user = requireRole(c, "admin");
  return c.json(await revokeApiKey(user, idParam(c)));
});

export default router;
