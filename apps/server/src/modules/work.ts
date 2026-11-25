import { Hono } from "hono";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { taskCloseSchema, type JobDetail, type TaskDetail, type WorkflowDetail } from "@iam/shared/api/iam";
import {
  JOB_STATUS_LABELS,
  OPEN_JOB_STATUSES,
  OPEN_WORKFLOW_STATUSES,
  TASK_STATUS_LABELS,
  WORKFLOW_STATUS_LABELS,
} from "@iam/shared/labels";
import {
  auditEvents,
  jobs,
  tasks,
  users,
  workflows,
  type JobStatus,
  type TaskStatus,
  type WorkflowStatus,
} from "../db/schema";
import { q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { idParam, jsonBody, requireRole } from "../http/middleware";
import { AppError, notFound } from "../http/errors";
import {
  ActionError,
  approveJob,
  cancelTask,
  completeTask,
  loadJob,
  rejectJob,
  retryJob,
} from "../engine/jobs";
import { cancelWorkflow, LifecycleError, tooLateFor } from "../engine/lifecycle";
import { countOf, eventRows, iso, jobRows, pageNumber, paginate, taskRows, workflowRows } from "./rows";

/** Workflows, jobs, tasks and the audit log. */
const router = new Hono<AppEnv>();
const PER_PAGE = 50;

async function actionOr409<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ActionError || error instanceof LifecycleError)
      throw new AppError(409, "action", error.message);
    throw error;
  }
}

// -- workflows ----------------------------------------------------------------------

router.get("/workflows", async (c) => {
  requireRole(c, "viewer");
  const status = c.req.query("status") ?? "open";
  let where: SQL | undefined;
  if (status === "open") where = inArray(workflows.status, [...OPEN_WORKFLOW_STATUSES]);
  else if (status in WORKFLOW_STATUS_LABELS) where = eq(workflows.status, status as WorkflowStatus);
  const total = await countOf(workflows, where);
  return c.json(
    await paginate(total, pageNumber(c.req.query("page")), PER_PAGE, (limit, offset) =>
      workflowRows(where, limit, offset),
    ),
  );
});

router.get("/workflows/:id", async (c) => {
  requireRole(c, "viewer");
  const id = idParam(c);
  const [row] = await workflowRows(eq(workflows.id, id), 1);
  if (!row) throw notFound();
  const [workflow] = await q().select().from(workflows).where(eq(workflows.id, id));
  const jobList = await jobRows(eq(jobs.workflowId, id), { byConnection: true });
  const running = jobList.filter((job) => job.status === "running");
  const body: WorkflowDetail = {
    ...row,
    isOpen: (OPEN_WORKFLOW_STATUSES as readonly string[]).includes(row.status),
    desired: Object.values(workflow!.desired).map((grant) => ({
      connection: grant.connection,
      groups: Object.values(grant.group_names ?? {}),
    })),
    jobs: jobList,
    tasks: await taskRows(
      inArray(tasks.jobId, q().select({ id: jobs.id }).from(jobs).where(eq(jobs.workflowId, id))),
    ),
    tooLate: running.length > 0 ? tooLateFor(running) : "",
  };
  return c.json(body);
});

router.post("/workflows/:id/cancel", async (c) => {
  const user = requireRole(c, "approver");
  const id = idParam(c);
  const [workflow] = await q().select({ id: workflows.id }).from(workflows).where(eq(workflows.id, id));
  if (!workflow) throw notFound();
  const running = await actionOr409(() => cancelWorkflow(id, { actor: user }));
  const tooLate = running.length > 0 ? ` ${tooLateFor(running)}` : "";
  return c.json({ id, message: `Cancelled the workflow.${tooLate}` });
});

// -- jobs -----------------------------------------------------------------------------

router.get("/jobs", async (c) => {
  requireRole(c, "viewer");
  const status = c.req.query("status") ?? "attention";
  const connection = c.req.query("connection") ?? "";
  const filters: (SQL | undefined)[] = [];
  if (status === "attention") filters.push(inArray(jobs.status, ["failed", "held"]));
  else if (status === "open") filters.push(inArray(jobs.status, [...OPEN_JOB_STATUSES]));
  else if (status in JOB_STATUS_LABELS) filters.push(eq(jobs.status, status as JobStatus));
  if (/^[0-9]+$/.test(connection)) filters.push(eq(jobs.connectionId, Number(connection)));
  const where = and(...filters);
  const total = await countOf(jobs, where);
  return c.json(
    await paginate(total, pageNumber(c.req.query("page")), PER_PAGE, (limit, offset) =>
      jobRows(where, { limit, offset }),
    ),
  );
});

router.get("/jobs/:id", async (c) => {
  requireRole(c, "viewer");
  const id = idParam(c);
  const [row] = await jobRows(eq(jobs.id, id));
  if (!row) throw notFound();
  const job = (await loadJob(id))!;
  const body: JobDetail = {
    ...row,
    groups: job.groups,
    finishedAt: iso(job.finishedAt),
    result: job.result,
    tasks: await taskRows(eq(tasks.jobId, id)),
    events: await eventRows(
      and(eq(auditEvents.targetType, "job"), eq(auditEvents.targetId, String(id))),
      1000,
    ),
  };
  return c.json(body);
});

for (const [path, role, run, message] of [
  ["retry", "approver", retryJob, "The job runs again."],
  ["approve", "admin", approveJob, "Approved. The job runs now."],
  ["reject", "admin", rejectJob, "Rejected. Nothing was changed."],
] as const) {
  router.post(`/jobs/:id/${path}`, async (c) => {
    const user = requireRole(c, role);
    const id = idParam(c);
    const [job] = await q().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id));
    if (!job) throw notFound();
    await actionOr409(() => run(id, { actor: user }));
    return c.json({ id, message });
  });
}

// -- tasks ------------------------------------------------------------------------------

router.get("/tasks", async (c) => {
  requireRole(c, "viewer");
  const status = c.req.query("status") ?? "open";
  const where = status in TASK_STATUS_LABELS ? eq(tasks.status, status as TaskStatus) : undefined;
  const total = await countOf(tasks, where);
  return c.json(
    await paginate(total, pageNumber(c.req.query("page")), PER_PAGE, (limit, offset) =>
      taskRows(where, limit, offset),
    ),
  );
});

router.get("/tasks/:id", async (c) => {
  requireRole(c, "viewer");
  const id = idParam(c);
  const [row] = await taskRows(eq(tasks.id, id));
  if (!row) throw notFound();
  const [task] = await q()
    .select({ task: tasks, completedBy: users })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.completedById))
    .where(eq(tasks.id, id));
  const body: TaskDetail = {
    ...row,
    instructions: task!.task.instructions,
    completedAt: iso(task!.task.completedAt),
    completedBy: task!.completedBy ? task!.completedBy.displayName || task!.completedBy.email : null,
    note: task!.task.note,
  };
  return c.json(body);
});

for (const [path, run, message] of [
  ["complete", completeTask, "Task completed."],
  ["cancel", cancelTask, "Task cancelled."],
] as const) {
  router.post(`/tasks/:id/${path}`, async (c) => {
    const user = requireRole(c, "approver");
    const id = idParam(c);
    const [task] = await q().select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id));
    if (!task) throw notFound();
    const { note } = await jsonBody(c, taskCloseSchema);
    await actionOr409(() => run(id, { actor: user, note: (note ?? "").trim() }));
    return c.json({ id, message });
  });
}

// -- audit log ----------------------------------------------------------------------------

router.get("/audit", async (c) => {
  requireRole(c, "viewer");
  const search = (c.req.query("q") ?? "").trim();
  const pattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const where = search ? sql`${auditEvents.summary} ilike ${pattern}` : undefined;
  const total = await countOf(auditEvents, where);
  return c.json(
    await paginate(total, pageNumber(c.req.query("page")), 100, (limit, offset) =>
      eventRows(where, limit, offset),
    ),
  );
});

export default router;
