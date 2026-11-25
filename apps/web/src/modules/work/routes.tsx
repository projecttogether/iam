import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import {
  JOB_FILTERS,
  TASK_FILTERS,
  WORKFLOW_FILTERS,
  type JobFilter,
  type TaskFilter,
  type WorkflowFilter,
} from "./api";
import { JobPage } from "./job-page";
import { JobsPage, TasksPage, WorkflowsPage } from "./lists";
import { TaskPage } from "./task-page";
import { WorkflowPage } from "./workflow-page";

const values = <T extends string>(filters: [T, string][]) => filters.map(([value]) => value) as [T, ...T[]];
const page = z.coerce.number().int().min(1).max(100_000).optional().catch(undefined);

const workflowsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/workflows",
  validateSearch: z.object({
    status: z.enum(values<WorkflowFilter>(WORKFLOW_FILTERS)).optional().catch(undefined),
    page,
  }),
  component: function WorkflowsRoute() {
    const search = workflowsRoute.useSearch();
    const navigate = workflowsRoute.useNavigate();
    return <WorkflowsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

const workflowRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/workflows/$workflowId",
  component: function WorkflowRoute() {
    const { workflowId } = workflowRoute.useParams();
    return <WorkflowPage key={workflowId} id={Number(workflowId)} />;
  },
});

const jobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/jobs",
  validateSearch: z.object({
    status: z.enum(values<JobFilter>(JOB_FILTERS)).optional().catch(undefined),
    connection: z.coerce.number().int().positive().optional().catch(undefined),
    page,
  }),
  component: function JobsRoute() {
    const search = jobsRoute.useSearch();
    const navigate = jobsRoute.useNavigate();
    return <JobsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

const jobRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/jobs/$jobId",
  component: function JobRoute() {
    const { jobId } = jobRoute.useParams();
    return <JobPage key={jobId} id={Number(jobId)} />;
  },
});

const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks",
  validateSearch: z.object({
    status: z.enum(values<TaskFilter>(TASK_FILTERS)).optional().catch(undefined),
    page,
  }),
  component: function TasksRoute() {
    const search = tasksRoute.useSearch();
    const navigate = tasksRoute.useNavigate();
    return <TasksPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks/$taskId",
  component: function TaskRoute() {
    const { taskId } = taskRoute.useParams();
    return <TaskPage key={taskId} id={Number(taskId)} />;
  },
});

export const routes: AnyRoute[] = [workflowsRoute, workflowRoute, jobsRoute, jobRoute, tasksRoute, taskRoute];
