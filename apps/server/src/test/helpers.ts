import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users, type Role, type User } from "../db/schema";
import { createApp } from "../http/app";
import { authentication } from "../http/middleware";

/** Empties every table between tests. */
export async function resetDatabase() {
  await getDb().execute(sql`
    truncate table iam_identityrequest, iam_apikey, iam_auditevent, iam_task, iam_job, iam_workflow, iam_syncrun, iam_account,
      iam_profilegrant_groups, iam_profilegrant, iam_team_groups, iam_person, iam_providergroup,
      iam_connection, iam_accessprofile, iam_team, iam_session, iam_user, iam_appsettings,
      iam_workerheartbeat restart identity cascade
  `);
}

/** An app user with a role (default: viewer at role@example.invalid). */
export async function createUser(role: Role, email?: string, values: Partial<User> = {}): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ email: email ?? `${role}@example.invalid`, role, ...values })
    .returning();
  return user!;
}

let app: ReturnType<typeof createApp> | undefined;

export function testApp() {
  app ??= createApp();
  return app;
}

/**
 * API tests act as an app user through the x-test-user header, instead of a
 * session from the sign-in provider (src/auth/session.ts has its own tests).
 */
export function signInWithTestHeader() {
  const original = authentication.resolve;
  authentication.resolve = async (c) => {
    const id = Number(c.req.header("x-test-user") ?? 0);
    if (!id) return original(c);
    const [user] = await getDb().select().from(users).where(eq(users.id, id));
    return user && user.isActive ? user : null;
  };
  return () => {
    authentication.resolve = original;
  };
}

/**
 * A request to the app as `user` (x-test-user), sent with the app's origin.
 * JSON bodies are sent as JSON.
 */
export async function request(
  method: string,
  path: string,
  options: { user?: Pick<User, "id"> | null; body?: unknown; headers?: Record<string, string> } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
): Promise<{ status: number; body: any; headers: Headers; text: string }> {
  const headers: Record<string, string> = {
    origin: "http://localhost:8000",
    accept: "application/json",
    ...options.headers,
  };
  if (options.user) headers["x-test-user"] = String(options.user.id);
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await testApp().request(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: type.includes("json") && text ? JSON.parse(text) : text,
    headers: response.headers,
    text,
  };
}

/** Waits until `check` returns a value (not undefined), polling every 100 ms. */
export async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
