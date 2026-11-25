import { keepPreviousData } from "@tanstack/react-query";
import type {
  JobDetail,
  JobRow,
  Paged,
  Ref,
  TaskDetail,
  TaskRow,
  WorkflowDetail,
  WorkflowRow,
} from "@iam/shared/api/iam";
import {
  JOB_STATUS_LABELS,
  TASK_STATUS_LABELS,
  WORKFLOW_STATUS_LABELS,
  type JobStatus,
  type TaskStatus,
  type WorkflowStatus,
} from "@iam/shared/labels";
import { api } from "@/lib/api";

/*
 * The status filters of the lists, as the Django version had them: a group
 * of statuses ("open", "attention"), one status, or "all". Each list has a
 * default the address leaves out.
 */

export type WorkflowFilter = "open" | WorkflowStatus | "all";
export const WORKFLOW_FILTERS = [
  ["open", "Open"],
  ...Object.entries(WORKFLOW_STATUS_LABELS),
  ["all", "All"],
] as [WorkflowFilter, string][];

export type JobFilter = "attention" | "open" | JobStatus | "all";
export const JOB_FILTERS = [
  ["attention", "Needs attention"],
  ["open", "Open"],
  ...Object.entries(JOB_STATUS_LABELS),
  ["all", "All"],
] as [JobFilter, string][];

export type TaskFilter = TaskStatus | "all";
export const TASK_FILTERS = [...Object.entries(TASK_STATUS_LABELS), ["all", "All"]] as [TaskFilter, string][];

export type WorkflowsSearch = { status?: WorkflowFilter; page?: number };
export type JobsSearch = { status?: JobFilter; connection?: number; page?: number };
export type TasksSearch = { status?: TaskFilter; page?: number };

export const workflowsQuery = (search: WorkflowsSearch) => ({
  queryKey: ["workflows", search],
  queryFn: () =>
    api.get<Paged<WorkflowRow>>("/workflows", { status: search.status ?? "open", page: search.page }),
  placeholderData: keepPreviousData,
});

export const workflowQuery = (id: number) => ({
  queryKey: ["workflow", id],
  queryFn: () => api.get<WorkflowDetail>(`/workflows/${id}`),
});

export const jobsQuery = (search: JobsSearch) => ({
  queryKey: ["jobs", search],
  queryFn: () =>
    api.get<Paged<JobRow>>("/jobs", {
      status: search.status ?? "attention",
      connection: search.connection,
      page: search.page,
    }),
  placeholderData: keepPreviousData,
});

export const jobQuery = (id: number) => ({
  queryKey: ["job", id],
  queryFn: () => api.get<JobDetail>(`/jobs/${id}`),
});

export const tasksQuery = (search: TasksSearch) => ({
  queryKey: ["tasks", search],
  queryFn: () => api.get<Paged<TaskRow>>("/tasks", { status: search.status ?? "open", page: search.page }),
  placeholderData: keepPreviousData,
});

export const taskQuery = (id: number) => ({
  queryKey: ["task", id],
  queryFn: () => api.get<TaskDetail>(`/tasks/${id}`),
});

/** Every connection's name, for the jobs' filter (viewers may read them). */
export const connectionNamesQuery = {
  queryKey: ["connection-names"],
  queryFn: () => api.get<Ref[]>("/connection-names"),
  staleTime: 60_000,
};
