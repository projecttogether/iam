import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { asc, eq } from "drizzle-orm";
import { identityRequestCreateSchema, type IdentityRequestOptions } from "@iam/shared/api/iam";
import { PERSON_TYPE_LABELS } from "@iam/shared/labels";
import { identityRequests, teams, type ApiKey } from "../db/schema";
import { q } from "../db/tx";
import { AppError, notFound } from "../http/errors";
import { idParam, jsonBody } from "../http/middleware";
import { apiKeyFrom, cancelRequest, receiveRequest, requestView } from "../engine/identity-requests";
import { loadSettings } from "../engine/settings";

/**
 * The API for other apps, under /api/integration/v1: identity requests,
 * with an API key (`Authorization: Bearer iam_…`) from Admin › API keys.
 * A key reaches nothing else, and no session reaches this API.
 * docs/api.md describes it.
 */

type KeyEnv = { Variables: { requestId: string; apiKey: ApiKey } };

const router = new Hono<KeyEnv>();

router.use("*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});
router.use("*", bodyLimit({ maxSize: 64 * 1024 }));
router.use("*", async (c, next) => {
  const key = await apiKeyFrom(c.req.header("authorization"));
  if (!key) {
    c.header("www-authenticate", 'Bearer realm="iam"');
    throw new AppError(401, "unauthorized", "Send a valid API key as a bearer token.");
  }
  c.set("apiKey", key);
  await next();
});

const keyOf = (c: Context<KeyEnv>) => c.get("apiKey");

router.get("/identity-requests/options", async (c) => {
  const allowed = (await loadSettings()).identityRequestTypes;
  const body: IdentityRequestOptions = {
    personTypes: allowed.map((value) => ({ value, label: PERSON_TYPE_LABELS[value] })),
    teams: await q().select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)),
  };
  return c.json(body);
});

router.post("/identity-requests", async (c) => {
  const input = await jsonBody(c, identityRequestCreateSchema);
  const { request, created } = await receiveRequest(input, keyOf(c));
  return c.json(await requestView(request), created ? 201 : 200);
});

router.get("/identity-requests/:id", async (c) => {
  const [request] = await q()
    .select()
    .from(identityRequests)
    .where(eq(identityRequests.id, idParam(c)));
  if (!request) throw notFound();
  return c.json(await requestView(request));
});

router.post("/identity-requests/:id/cancel", async (c) => {
  return c.json(await requestView(await cancelRequest(idParam(c), keyOf(c))));
});

export default router;
