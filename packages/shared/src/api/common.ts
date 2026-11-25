import { z } from "zod";

export const idSchema = z.uuid();

/** Every error response: `{ error: { code, message, fields? } }`. Messages are shown to people. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Optional text: blank becomes null. */
export const nullableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable(),
  );

/** A secret in a form: omitted or null keeps the stored value, a string replaces it. */
export const secretInput = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().max(max).nullish(),
  );

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const okSchema = z.object({ ok: z.literal(true) });

/** A time of day, 24-hour, e.g. "02:30". */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 02:30");
