import { randomUUID } from "node:crypto";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { ROLE_RANK } from "@iam/shared/labels";
import { config } from "../config";
import type { Role, User } from "../db/schema";
import { currentSession } from "../auth/session";
import { logger } from "../logger";
import type { AppEnv } from "./env";
import { AppError, badRequest, parseWith, unauthorized } from "./errors";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

/** Logs each request by its route pattern: paths and queries can carry names and email addresses. */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = performance.now();
  await next();
  const path = c.req.path;
  if (path.startsWith("/-/") || path.startsWith("/assets/")) return;
  logger.info(
    {
      requestId: c.get("requestId"),
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    },
    "request",
  );
};

/** Tests only: replaces how a request finds its signed-in user. */
export const authentication: { resolve: (c: Context<AppEnv>) => Promise<User | null> } = {
  resolve: async (c) => (await currentSession(c))?.user ?? null,
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", await authentication.resolve(c));
  await next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request protection for the browser: changes need an Origin of
 * the application itself.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  const allowed = new URL(config().APP_URL).origin;
  if (origin ? origin !== allowed : c.req.header("sec-fetch-site") !== "same-origin") {
    throw new AppError(403, "forbidden", "Cross-site request rejected");
  }
  await next();
};

/** Whether the user's role is at least `role`. */
export function hasRole(user: Pick<User, "role" | "isActive"> | null, role: Role): boolean {
  return Boolean(user && user.isActive && (ROLE_RANK[user.role] ?? 0) >= ROLE_RANK[role]);
}

/**
 * The signed-in user with at least `role`: 401 without a session, 403 with
 * a lower role. Viewers read; approvers manage people, workflows and tasks;
 * admins also manage policy, connections, users and settings.
 */
export function requireRole(c: Context<AppEnv>, role: Role): User {
  const user = c.get("user");
  if (!user) throw unauthorized();
  if (!hasRole(user, role)) throw new AppError(403, "forbidden", "Your role does not allow this.");
  return user;
}

/** The JSON body validated with a schema. */
export async function jsonBody<T extends z.ZodType, E extends Env>(
  c: Context<E>,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("The request body must be JSON");
  }
  return parseWith(schema, body);
}

export function queryOf<T extends z.ZodType, E extends Env>(c: Context<E>, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}

/** A route parameter that must be a positive integer ID (404 otherwise, like an unknown one). */
export function idParam<E extends Env>(c: Context<E>, name = "id"): number {
  const value = c.req.param(name) ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new AppError(404, "not_found", "Not found");
  return Number(value);
}
