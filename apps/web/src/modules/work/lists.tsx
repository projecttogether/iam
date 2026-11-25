import type { ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Paged } from "@iam/shared/api/iam";
import { Card } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Empty, JobsTable, PageControls, TasksTable, WorkflowsTable } from "@/components/lists";
import {
  connectionNamesQuery,
  JOB_FILTERS,
  jobsQuery,
  TASK_FILTERS,
  tasksQuery,
  WORKFLOW_FILTERS,
  workflowsQuery,
  type JobFilter,
  type JobsSearch,
  type TaskFilter,
  type TasksSearch,
  type WorkflowFilter,
  type WorkflowsSearch,
} from "./api";

/** A filter of a list: a native select that applies at once. */
function Filter<T extends string>(props: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <NativeSelect
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as T)}
    >
      {props.options.map(([value, label]) => (
        <NativeSelectOption key={value} value={value}>
          {label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** A paged list: its filters, then loading, error, empty text, or the table with its pager. */
function ListPage<T>(props: {
  title: string;
  description: string;
  filters: ReactNode;
  query: UseQueryResult<Paged<T>>;
  empty: string;
  onPage: (page: number) => void;
  children: (items: T[]) => ReactNode;
}) {
  const { query } = props;
  return (
    <Page>
      <PageHeader title={props.title} description={props.description} />
      <div className="flex flex-wrap items-center gap-2">{props.filters}</div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <Empty>{props.empty}</Empty>
      ) : (
        <>
          <Card className="py-0">{props.children(query.data.items)}</Card>
          <PageControls data={query.data} onPage={props.onPage} />
        </>
      )}
    </Page>
  );
}

const pageOf = (page: number) => (page > 1 ? page : undefined);

/** /workflows: open ones first; or those of one status, or all. */
export function WorkflowsPage({
  search,
  onSearch,
}: {
  search: WorkflowsSearch;
  onSearch: (search: WorkflowsSearch) => void;
}) {
  const query = useQuery(workflowsQuery(search));
  return (
    <ListPage
      title="Workflows"
      description="Onboarding, access updates and offboarding, one per person and change."
      filters={
        <Filter<WorkflowFilter>
          label="Status"
          value={search.status ?? "open"}
          options={WORKFLOW_FILTERS}
          onChange={(status) => onSearch({ status: status === "open" ? undefined : status })}
        />
      }
      query={query}
      empty="No workflows."
      onPage={(page) => onSearch({ ...search, page: pageOf(page) })}
    >
      {(items) => <WorkflowsTable workflows={items} />}
    </ListPage>
  );
}

/** /jobs: failed and held ones first; or open ones, one status, or all; at one connection or all. */
export function JobsPage({
  search,
  onSearch,
}: {
  search: JobsSearch;
  onSearch: (search: JobsSearch) => void;
}) {
  const query = useQuery(jobsQuery(search));
  const connections = useQuery(connectionNamesQuery).data ?? [];
  return (
    <ListPage
      title="Jobs"
      description="Each job is one change at one connection."
      filters={
        <>
          <Filter<JobFilter>
            label="Status"
            value={search.status ?? "attention"}
            options={JOB_FILTERS}
            onChange={(status) =>
              onSearch({ ...search, status: status === "attention" ? undefined : status, page: undefined })
            }
          />
          <Filter<string>
            label="Connection"
            value={search.connection ? String(search.connection) : ""}
            options={[
              ["", "All connections"],
              ...connections.map((connection): [string, string] => [String(connection.id), connection.name]),
              // A connection from the address that no longer exists.
              ...(search.connection && !connections.some((connection) => connection.id === search.connection)
                ? [[String(search.connection), `Connection ${search.connection}`] as [string, string]]
                : []),
            ]}
            onChange={(connection) =>
              onSearch({
                ...search,
                connection: connection ? Number(connection) : undefined,
                page: undefined,
              })
            }
          />
        </>
      }
      query={query}
      empty="No jobs."
      onPage={(page) => onSearch({ ...search, page: pageOf(page) })}
    >
      {(items) => <JobsTable jobs={items} />}
    </ListPage>
  );
}

/** /tasks: open ones first; or those of one status, or all. */
export function TasksPage({
  search,
  onSearch,
}: {
  search: TasksSearch;
  onSearch: (search: TasksSearch) => void;
}) {
  const query = useQuery(tasksQuery(search));
  return (
    <ListPage
      title="Tasks"
      description="Changes a person makes by hand: apps without automation, and jobs that need help."
      filters={
        <Filter<TaskFilter>
          label="Status"
          value={search.status ?? "open"}
          options={TASK_FILTERS}
          onChange={(status) => onSearch({ status: status === "open" ? undefined : status })}
        />
      }
      query={query}
      empty="No tasks."
      onPage={(page) => onSearch({ ...search, page: pageOf(page) })}
    >
      {(items) => <TasksTable tasks={items} />}
    </ListPage>
  );
}
