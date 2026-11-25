import { Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { devLoginSchema, type AuthConfig, type Me } from "@iam/shared/api/iam";
import { ROLE_LABELS } from "@iam/shared/labels";
import { config } from "../config";
import { identityRequests, jobs, tasks, users } from "../db/schema";
import { q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { hasRole, jsonBody, requireRole } from "../http/middleware";
import { notFound } from "../http/errors";
import { accountUrl, providerLogoutUrl } from "../auth/oidc";
import { endSession, startSession } from "../auth/session";
import { loadSettings } from "../engine/settings";
import { countOf } from "./rows";

const router = new Hono<AppEnv>();

router.get("/auth-config", (c) => {
  const settings = config();
  const body: AuthConfig = {
    appName: "IAM",
    signedIn: c.get("user") !== null,
    providerName: settings.oidcProviderName,
    oidcEnabled: settings.oidcEnabled,
    devLogin: settings.isDevelopment && settings.DEV_LOGIN,
  };
  return c.json(body);
});

router.get("/me", async (c) => {
  const user = requireRole(c, "viewer");
  const settings = config();
  const body: Me = {
    id: user.id,
    email: user.email,
    name: user.displayName || user.email,
    role: user.role,
    isAdmin: hasRole(user, "admin"),
    isApprover: hasRole(user, "approver"),
    organizationName: (await loadSettings()).organizationName,
    accountUrl: accountUrl(),
    readOnly: settings.READ_ONLY,
    version: settings.APP_VERSION ?? "",
    counts: {
      openTasks: await countOf(tasks, eq(tasks.status, "open")),
      failedJobs: await countOf(jobs, eq(jobs.status, "failed")),
      heldJobs: await countOf(jobs, eq(jobs.status, "held")),
      openRequests: await countOf(identityRequests, eq(identityRequests.status, "open")),
    },
  };
  return c.json(body);
});

/** Signs out here, and tells the browser where to go: the provider's sign-out, or the sign-in page. */
router.post("/auth/logout", async (c) => {
  const idToken = await endSession(c);
  return c.json({ redirect: await providerLogoutUrl(idToken) });
});

const devLoginEnabled = () => config().isDevelopment && config().DEV_LOGIN;

/** Development only (DEV_LOGIN=1 with NODE_ENV=development): sign in as an existing app user. */
router.get("/auth/dev-users", async (c) => {
  if (!devLoginEnabled()) throw notFound();
  const rows = await q().select().from(users).where(eq(users.isActive, true)).orderBy(asc(users.email));
  return c.json(rows.map((user) => ({ email: user.email, role: ROLE_LABELS[user.role] })));
});

router.post("/auth/dev-login", async (c) => {
  if (!devLoginEnabled()) throw notFound();
  const { email } = await jsonBody(c, devLoginSchema);
  const [user] = await q()
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, eq(users.isActive, true)))
    .limit(1);
  if (!user) throw notFound("No active app user has this address.");
  if (!(await startSession(c, user))) throw notFound("No active app user has this address.");
  return c.json({ ok: true });
});

export default router;
