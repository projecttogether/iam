import { auditEvents, type AuditEvent, type User } from "../db/schema";
import { q } from "../db/tx";

/** The audit log. Every change by a person or the worker writes one event. */

export const WORKER_LABEL = "Worker";
export const OPERATOR_LABEL = "operator";

const OPERATOR = Symbol("operator");

/**
 * Whoever runs an operator command on the server (`cli`, docs/deployment.md),
 * with an admin's rights. Only the command line creates one (src/cli): a
 * request carries no symbol, so no HTTP route can stand for it.
 */
export type Operator = { readonly [OPERATOR]: true; readonly command: string };

/** Who changes a setting: an admin of the web app or the operator. */
export type Actor = User | Operator;

/** The operator running `command`, e.g. `cli settings apply connections`. Command line only. */
export function operator(command: string): Operator {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is Operator {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}

/** What an event is about, e.g. `{ type: "job", id: 7 }` (the Django model name in lower case). */
export type Target = { type: string; id: number | string };

export async function record(
  action: string,
  summary: string,
  options: {
    /** An app user, or the operator (labelled `operator`, with the command in the details). */
    actor?: Pick<User, "id" | "email"> | Operator | null;
    /** Who acted when it was no app user, e.g. an API key; default: the worker. */
    actorLabel?: string;
    personId?: number | null;
    target?: Target | null;
    details?: Record<string, unknown>;
  } = {},
): Promise<AuditEvent> {
  const byOperator = isOperator(options.actor) ? options.actor : null;
  const actor = byOperator
    ? null
    : ((options.actor as Pick<User, "id" | "email"> | null | undefined) ?? null);
  const label = actor ? actor.email : byOperator ? OPERATOR_LABEL : (options.actorLabel ?? WORKER_LABEL);
  const [event] = await q()
    .insert(auditEvents)
    .values({
      actorId: actor?.id ?? null,
      actorLabel: label.slice(0, 255),
      action,
      summary: summary.slice(0, 500),
      personId: options.personId ?? null,
      targetType: options.target?.type ?? "",
      targetId: options.target ? String(options.target.id) : "",
      details: byOperator ? { ...options.details, command: byOperator.command } : (options.details ?? {}),
    })
    .returning();
  return event!;
}
