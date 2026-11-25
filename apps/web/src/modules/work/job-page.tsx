import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { JOB_ACTION_LABELS, JOB_STATUS_LABELS, WORKFLOW_KIND_LABELS } from "@iam/shared/labels";
import { useFormatter } from "@/lib/format";
import { useRecordTitle } from "@/app/record-name";
import { Detail, Details, Section } from "@/components/detail";
import { StatusBadge } from "@/components/status";
import { Empty, EventsTable, TasksTable, TextLink } from "@/components/lists";
import { jobQuery } from "./api";
import { JobActions } from "@/components/job-actions";

/** A value of a job's result as text: yes or no for true and false, "—" for nothing. */
export function resultText(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.map(resultText).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** /jobs/$jobId: one change at one connection, its result, tasks and history. */
export function JobPage({ id }: { id: number }) {
  const format = useFormatter();
  const query = useQuery(jobQuery(id));
  const job = query.data;
  useRecordTitle(
    `/jobs/${id}`,
    job ? `${JOB_ACTION_LABELS[job.action]} at ${job.connection.name}` : undefined,
  );
  if (query.isPending) return <LoadingState />;
  if (query.isError || !job) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const result = Object.entries(job.result);
  return (
    <Page>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {JOB_ACTION_LABELS[job.action]} at {job.connection.name}
            <StatusBadge value={job.status} labels={JOB_STATUS_LABELS} />
          </span>
        }
        description={
          <>
            For <TextLink to={`/people/${job.person.id}`}>{job.person.name}</TextLink> · part of{" "}
            <TextLink to={`/workflows/${job.workflow.id}`}>
              {WORKFLOW_KIND_LABELS[job.workflow.kind].toLowerCase()}
            </TextLink>
          </>
        }
        actions={<JobActions job={job} />}
      />
      {job.status === "rehearsed" ? (
        <Alert>
          <Info />
          <AlertDescription>
            Read-only mode checked this job and changed nothing. The result shows what it would have done.
          </AlertDescription>
        </Alert>
      ) : null}
      {job.status === "held" ? (
        <Alert>
          <AlertDescription>
            This automatic removal is over the daily limit (Admin › Settings). Approve it to run it, or reject
            it to keep the account.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Details">
          <Details className="lg:grid-cols-2">
            <Detail label="Attempts">{job.attempts}</Detail>
            <Detail label="Created">{format.dateTime(job.createdAt)}</Detail>
            {job.status === "queued" ? (
              <Detail label="Next attempt">{format.dateTime(job.nextAttemptAt)}</Detail>
            ) : null}
            {job.finishedAt ? <Detail label="Finished">{format.dateTime(job.finishedAt)}</Detail> : null}
            <Detail label="Groups">{job.groups.length > 0 ? job.groups.join(", ") : "—"}</Detail>
            {job.lastError ? (
              <Detail label="Last error" className="sm:col-span-full">
                <span className="whitespace-pre-line">{job.lastError}</span>
              </Detail>
            ) : null}
          </Details>
        </Section>
        <Section title="Result">
          {result.length === 0 ? (
            <Empty>No result yet.</Empty>
          ) : (
            <Details className="lg:grid-cols-2">
              {result.map(([key, value]) => (
                <Detail key={key} label={key}>
                  {resultText(value)}
                </Detail>
              ))}
            </Details>
          )}
        </Section>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Tasks">
          <TasksTable tasks={job.tasks} showPerson={false} />
        </Section>
        <Section title="History">
          <EventsTable events={job.events} />
        </Section>
      </div>
    </Page>
  );
}
