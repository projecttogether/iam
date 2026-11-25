import { asc, count, desc, eq, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { EventRow, JobRow, Paged, TaskRow, WorkflowRow } from "@iam/shared/api/iam";
import { auditEvents, connections, jobs, people, tasks, users, workflows } from "../db/schema";
import { q } from "../db/tx";
import { fullName } from "../engine/people";

/** How lists turn rows into what the web app shows. */

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** The page number of `?page=`: invalid values give the first page, numbers past the end the last (Django's get_page). */
export function pageNumber(value: string | undefined): number {
  const page = Number.parseInt(value ?? "", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

export async function paginate<T>(
  total: number,
  page: number,
  perPage: number,
  load: (limit: number, offset: number) => Promise<T[]>,
): Promise<Paged<T>> {
  const pages = Math.max(Math.ceil(total / perPage), 1);
  const current = Math.min(page, pages);
  return { items: await load(perPage, (current - 1) * perPage), page: current, pages, total };
}

export async function countOf(table: PgTable, where?: SQL): Promise<number> {
  const [row] = await q().select({ value: count() }).from(table).where(where);
  return Number(row?.value ?? 0);
}

export async function eventRows(where: SQL | undefined, limit: number, offset = 0): Promise<EventRow[]> {
  const rows = await q()
    .select({ event: auditEvents, person: people })
    .from(auditEvents)
    .leftJoin(people, eq(people.id, auditEvents.personId))
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit)
    .offset(offset);
  return rows.map(({ event, person }) => ({
    id: event.id,
    createdAt: event.createdAt.toISOString(),
    actorLabel: event.actorLabel,
    action: event.action,
    summary: event.summary,
    person: person ? { id: person.id, name: fullName(person) } : null,
  }));
}

export async function taskRows(where: SQL | undefined, limit?: number, offset = 0): Promise<TaskRow[]> {
  let query = q()
    .select({ task: tasks, person: people, connection: connections })
    .from(tasks)
    .leftJoin(people, eq(people.id, tasks.personId))
    .leftJoin(connections, eq(connections.id, tasks.connectionId))
    .where(where)
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .$dynamic();
  if (limit !== undefined) query = query.limit(limit).offset(offset) as typeof query;
  const rows = await query;
  return rows.map(({ task, person, connection }) => ({
    id: task.id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    person: person ? { id: person.id, name: fullName(person) } : null,
    connection: connection ? { id: connection.id, name: connection.name } : null,
    jobId: task.jobId,
  }));
}

export async function jobRows(
  where: SQL | undefined,
  options: { limit?: number; offset?: number; byConnection?: boolean } = {},
): Promise<JobRow[]> {
  let query = q()
    .select({ job: jobs, person: people, connection: connections, workflow: workflows })
    .from(jobs)
    .innerJoin(people, eq(people.id, jobs.personId))
    .innerJoin(connections, eq(connections.id, jobs.connectionId))
    .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
    .where(where)
    .orderBy(
      ...(options.byConnection
        ? [asc(connections.name), asc(jobs.id)]
        : [desc(jobs.createdAt), asc(connections.name), desc(jobs.id)]),
    )
    .$dynamic();
  if (options.limit !== undefined)
    query = query.limit(options.limit).offset(options.offset ?? 0) as typeof query;
  const rows = await query;
  return rows.map(({ job, person, connection, workflow }) => ({
    id: job.id,
    action: job.action,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    nextAttemptAt: job.nextAttemptAt.toISOString(),
    person: { id: person.id, name: fullName(person) },
    connection: { id: connection.id, name: connection.name },
    workflow: { id: workflow.id, kind: workflow.kind },
  }));
}

export async function workflowRows(
  where: SQL | undefined,
  limit?: number,
  offset = 0,
): Promise<WorkflowRow[]> {
  let query = q()
    .select({ workflow: workflows, person: people, creator: users })
    .from(workflows)
    .innerJoin(people, eq(people.id, workflows.personId))
    .leftJoin(users, eq(users.id, workflows.createdById))
    .where(where)
    .orderBy(desc(workflows.createdAt), desc(workflows.id))
    .$dynamic();
  if (limit !== undefined) query = query.limit(limit).offset(offset) as typeof query;
  const rows = await query;
  return rows.map(({ workflow, person, creator }) => ({
    id: workflow.id,
    kind: workflow.kind,
    status: workflow.status,
    reason: workflow.reason,
    automatic: workflow.automatic,
    createdAt: workflow.createdAt.toISOString(),
    finishedAt: iso(workflow.finishedAt),
    person: { id: person.id, name: fullName(person) },
    createdBy: creator ? creator.displayName || creator.email : null,
  }));
}
