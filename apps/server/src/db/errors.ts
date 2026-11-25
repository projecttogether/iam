/**
 * PostgreSQL errors of a change that ran into another one at the same time:
 * unique violation, deadlock, serialization failure. Trying again gives the
 * right answer.
 */
const CONCURRENT_CHANGE_CODES = new Set(["23505", "40P01", "40001"]);

export const CONCURRENT_CHANGE_MESSAGE = "Someone else changed this at the same time. Try again.";

/** The SQLSTATE of a database error, also when Drizzle wrapped it (`cause`). */
export function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

export function isConcurrentChange(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code !== undefined && CONCURRENT_CHANGE_CODES.has(code);
}
