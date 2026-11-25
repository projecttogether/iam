import type { z } from "zod";
import { translate, defineMessages } from "@/i18n";
import { ApiError } from "./api";

/** Messages by dotted field path, e.g. `{ "config.subject": "Enter an email address" }`. */
export type FieldErrors = Record<string, string>;

/**
 * Validation messages. The shared schemas carry their own messages; zod's
 * built-in ones are replaced by plain ones.
 */
const generic = defineMessages({
  en: {
    required: "Required",
    tooLong: "At most {max} characters",
    tooFew: "Add at least {min}",
    tooMany: "At most {max}",
    min: "At least {min}",
    max: "At most {max}",
    url: "Enter a full address, e.g. https://example.invalid",
    email: "Enter an email address",
    format: "Check the format",
    number: "Enter a whole number",
    choose: "Choose an option",
    invalid: "Check this value",
  },
});

const t = translate(generic, "en");

type Issue = {
  code: string;
  origin?: string;
  format?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  expected?: string;
  input?: unknown;
};

/** A plain message for zod's built-in checks (custom messages of the schemas win). */
export function issueMessage(issue: Issue): string {
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string")
        return Number(issue.minimum) <= 1 ? t("required") : t("min", { min: String(issue.minimum) });
      if (issue.origin === "array") return t("tooFew", { min: String(issue.minimum) });
      return t("min", { min: String(issue.minimum) });
    case "too_big":
      if (issue.origin === "string") return t("tooLong", { max: String(issue.maximum) });
      if (issue.origin === "array") return t("tooMany", { max: String(issue.maximum) });
      return t("max", { max: String(issue.maximum) });
    case "invalid_format":
      if (issue.format === "url") return t("url");
      if (issue.format === "email") return t("email");
      return t("format");
    case "invalid_type":
      if (issue.expected === "number" || issue.expected === "int") return t("number");
      if (issue.input === null || issue.input === undefined || issue.input === "") return t("required");
      return t("invalid");
    case "invalid_value":
    case "invalid_union":
      return t("choose");
    default:
      return t("invalid");
  }
}

/** Checks a value with a shared schema before sending it: field messages, or null when valid. */
export function validate(schema: z.ZodType, value: unknown): FieldErrors | null {
  const result = schema.safeParse(value, { error: (issue) => issueMessage(issue as Issue) });
  if (result.success) return null;
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join(".");
    errors[key] ??= issue.message;
  }
  return errors;
}

/** The field messages of a failed request (`fields`, keyed by dotted path). */
export function serverFieldErrors(error: unknown): FieldErrors {
  return error instanceof ApiError && error.fields ? error.fields : {};
}

/** The first message at a path or below it (`config.scope.folders` also finds `config.scope.folders.0.id`). */
export function errorAt(errors: FieldErrors, path: string): string | undefined {
  if (errors[path]) return errors[path];
  const key = Object.keys(errors).find((item) => item.startsWith(`${path}.`));
  return key ? errors[key] : undefined;
}

/** Messages whose paths no field of the form shows, to show above the buttons. */
export function otherErrors(errors: FieldErrors, shown: RegExp): string[] {
  return Object.entries(errors)
    .filter(([key]) => !shown.test(key))
    .map(([, message]) => message);
}
