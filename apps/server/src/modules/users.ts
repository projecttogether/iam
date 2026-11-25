import { Hono } from "hono";
import { and, asc, eq, ne } from "drizzle-orm";
import { userInputSchema, type UserRow } from "@iam/shared/api/iam";
import { ROLE_LABELS } from "@iam/shared/labels";
import { people, sessions, users, type User } from "../db/schema";
import { atomic, q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, requireRole } from "../http/middleware";
import { AppError, notFound, validationError } from "../http/errors";
import { record } from "../engine/audit";
import { fullName } from "../engine/people";
import { iso } from "./rows";

/** Admin › Users and roles: who may use this app, with which role. */
const router = new Hono<AppEnv>();

async function rows(where?: ReturnType<typeof eq>): Promise<UserRow[]> {
  const list = await q()
    .select({ user: users, person: people })
    .from(users)
    .leftJoin(people, eq(people.id, users.personId))
    .where(where)
    .orderBy(asc(users.email));
  return list.map(({ user, person }) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    roleSource: user.roleSource,
    isActive: user.isActive,
    linked: user.oidcSubject !== null,
    person: person ? { id: person.id, name: fullName(person) } : null,
    lastLogin: iso(user.lastLogin),
  }));
}

router.get("/users", async (c) => {
  requireRole(c, "admin");
  return c.json(await rows());
});

router.get("/users/options", async (c) => {
  requireRole(c, "admin");
  const list = await q()
    .select()
    .from(people)
    .orderBy(asc(people.lastName), asc(people.firstName), asc(people.id));
  return c.json({ people: list.map((person) => ({ id: person.id, name: fullName(person) })) });
});

router.get("/users/:id", async (c) => {
  requireRole(c, "admin");
  const [row] = await rows(eq(users.id, idParam(c)));
  if (!row) throw notFound();
  return c.json(row);
});

const FIELD_NAMES: Record<string, string> = {
  email: "email",
  displayName: "display_name",
  role: "role",
  isActive: "is_active",
  personId: "person",
};

async function saveUser(actor: User, existing: User | null, input: ReturnType<typeof userInputSchema.parse>) {
  const email = input.email.trim().toLowerCase();
  const errors: Record<string, string> = {};
  const others = (column: typeof users.email | typeof users.personId, value: string | number) =>
    q()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(column, value), existing ? ne(users.id, existing.id) : undefined))
      .limit(1);
  if ((await others(users.email, email)).length > 0) errors.email = "User with this Email already exists.";
  if (input.personId !== null) {
    const [person] = await q().select({ id: people.id }).from(people).where(eq(people.id, input.personId));
    if (!person) errors.personId = "Select a valid choice. That choice is not one of the available choices.";
    else if ((await others(users.personId, input.personId)).length > 0) {
      errors.personId = "User with this Person already exists.";
    }
  }
  if (Object.keys(errors).length > 0) throw validationError(errors);
  if (existing?.id === actor.id && (!input.isActive || input.role !== "admin")) {
    throw new AppError(409, "own_access", "You cannot remove your own admin access.");
  }
  const values = {
    email,
    displayName: input.displayName,
    role: input.role,
    isActive: input.isActive,
    personId: input.personId,
  };
  const changed = Object.keys(FIELD_NAMES).filter((key) =>
    existing === null
      ? key !== "isActive" || !input.isActive
      : (existing[key as keyof User] ?? null) !== (values[key as keyof typeof values] ?? null),
  );
  return atomic(async () => {
    let saved: User;
    if (existing === null) {
      [saved] = (await q()
        .insert(users)
        .values({ ...values, roleSource: "local" })
        .returning()) as [User];
    } else {
      const update: Partial<User> = {};
      for (const key of changed) Object.assign(update, { [key]: values[key as keyof typeof values] });
      if (changed.includes("role")) update.roleSource = "local";
      // Only the changed fields: keeps the subject a sign-in bound during this edit.
      [saved] = (
        Object.keys(update).length > 0
          ? await q().update(users).set(update).where(eq(users.id, existing.id)).returning()
          : [existing]
      ) as [User];
      // Turned off: its sessions end, so turning it on again needs a new sign-in.
      if (!saved.isActive) await q().delete(sessions).where(eq(sessions.userId, saved.id));
    }
    await record("user.saved", `Saved app user ${saved.email} (${ROLE_LABELS[saved.role]})`, {
      actor,
      target: { type: "user", id: saved.id },
      details: { fields: changed.map((key) => FIELD_NAMES[key]!).sort() },
    });
    return saved;
  });
}

router.post("/users", async (c) => {
  const actor = requireRole(c, "admin");
  const saved = await saveUser(actor, null, await jsonBody(c, userInputSchema));
  return c.json({ id: saved.id, message: `Saved ${saved.email}.` }, 201);
});

router.put("/users/:id", async (c) => {
  const actor = requireRole(c, "admin");
  const [existing] = await q()
    .select()
    .from(users)
    .where(eq(users.id, idParam(c)));
  if (!existing) throw notFound();
  const saved = await saveUser(actor, existing, await jsonBody(c, userInputSchema));
  return c.json({ id: saved.id, message: `Saved ${saved.email}.` });
});

export default router;
