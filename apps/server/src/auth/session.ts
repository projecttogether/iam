import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config";
import { sessions, users, type User } from "../db/schema";
import { getDb } from "../db/client";

/**
 * Browser sessions. The cookie holds a random token; the database keeps its
 * SHA-256 with the user and the expiry (SESSION_HOURS after sign-in; using
 * the app does not extend it). A session counts only while its user is
 * active.
 */

/**
 * The cookie's name. On HTTPS with the `__Host-` prefix: the browser then
 * takes it only from this host itself, never from a sibling subdomain.
 */
export function cookieName(name: string): string {
  return secureCookies() ? `__Host-${name}` : name;
}

const sessionCookie = () => cookieName("iam_session");

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function secureCookies(): boolean {
  return config().APP_URL.startsWith("https://");
}

/**
 * Starts a session for the user and sets its cookie; null when the user was
 * turned off meanwhile. The user's row is locked while the session is
 * written, so a user turned off at the same time loses it with the others.
 */
export async function startSession(c: Context, user: Pick<User, "id">, idToken = ""): Promise<Date | null> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config().SESSION_HOURS * 3600 * 1000);
  // A new sign-in replaces the session the browser had.
  await endSession(c);
  const started = await getDb().transaction(async (tx) => {
    const [active] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, user.id), eq(users.isActive, true)))
      // Not "share": two sign-ins of one user would both hold it, then
      // deadlock on last_login. This one waits for the other, and for a
      // deactivation, before writing its session.
      .for("no key update");
    if (!active) return false;
    await tx.insert(sessions).values({ id: hash(token), userId: user.id, expiresAt, idToken });
    // The same time in both: a later last_login comes from the Django
    // version after a rollback (endSessionsBeforeDjangoSignIns).
    const signedInAt = new Date();
    await tx
      .update(users)
      .set({ lastLogin: signedInAt, lastSessionAt: signedInAt })
      .where(eq(users.id, user.id));
    return true;
  });
  if (!started) return null;
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
  setCookie(c, sessionCookie(), token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
  return expiresAt;
}

/** The signed-in user of the request and the provider's ID token of the session, or null. */
export async function currentSession(c: Context): Promise<{ user: User; idToken: string } | null> {
  const token = getCookie(c, sessionCookie());
  if (!token || token.length > 200) return null;
  const [row] = await getDb()
    .select({ user: users, idToken: sessions.idToken })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hash(token)), gt(sessions.expiresAt, new Date()), eq(users.isActive, true)));
  return row ?? null;
}

/** Ends the request's session; returns the provider's ID token it had. */
export async function endSession(c: Context): Promise<string> {
  const token = getCookie(c, sessionCookie());
  deleteCookie(c, sessionCookie(), { path: "/", secure: secureCookies() });
  if (!token || token.length > 200) return "";
  const [row] = await getDb()
    .delete(sessions)
    .where(eq(sessions.id, hash(token)))
    .returning({ idToken: sessions.idToken });
  return row?.idToken ?? "";
}

// -- signed values (the sign-in's state cookie) ------------------------------------

function signature(value: string): string {
  return createHmac("sha256", `iam-signed:${config().AUTH_SECRET}`).update(value).digest("base64url");
}

export function sign(data: unknown): string {
  const value = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${value}.${signature(value)}`;
}

export function unsign<T>(signed: string | undefined): T | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(signature(value));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
