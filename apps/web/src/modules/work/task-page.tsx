import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { TASK_KIND_LABELS, TASK_STATUS_LABELS } from "@iam/shared/labels";
import type { TaskDetail } from "@iam/shared/api/iam";
import { useMe } from "@/hooks/use-me";
import { useAction } from "@/hooks/use-action";
import { useFormatter } from "@/lib/format";
import { useRecordTitle } from "@/app/record-name";
import { Detail, Details, Section } from "@/components/detail";
import { TextareaField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status";
import { TextLink } from "@/components/lists";
import { taskQuery } from "./api";

/** Approvers close an open task: done, or cancelled, with an optional note. */
function CloseTask({ task }: { task: TaskDetail }) {
  const [note, setNote] = useState("");
  const close = useAction();
  const run = (path: "complete" | "cancel") =>
    close.mutate({ path: `/tasks/${task.id}/${path}`, body: { note } });
  return (
    <Section title="Close the task">
      <TextareaField
        id="task-note"
        label="Note (optional)"
        placeholder="What you did"
        rows={3}
        maxLength={2000}
        value={note}
        onChange={setNote}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={close.isPending} onClick={() => run("complete")}>
          Mark as done
        </Button>
        <Button variant="destructive" disabled={close.isPending} onClick={() => run("cancel")}>
          Cancel task
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        Done records the change as made. Cancel drops the change; the person&apos;s access then differs from
        the policy.
      </p>
    </Section>
  );
}

/** /tasks/$taskId: what to do by hand, and closing it. */
export function TaskPage({ id }: { id: number }) {
  const me = useMe();
  const format = useFormatter();
  const query = useQuery(taskQuery(id));
  const task = query.data;
  useRecordTitle(`/tasks/${id}`, task?.title);
  if (query.isPending) return <LoadingState />;
  if (query.isError || !task) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {task.title}
            <StatusBadge value={task.status} labels={TASK_STATUS_LABELS} />
          </span>
        }
        description={
          <>
            {TASK_KIND_LABELS[task.kind]}
            {task.person ? (
              <>
                {" · "}
                <TextLink to={`/people/${task.person.id}`}>{task.person.name}</TextLink>
              </>
            ) : null}
            {task.jobId ? (
              <>
                {" · "}
                <TextLink to={`/jobs/${task.jobId}`}>job</TextLink>
              </>
            ) : null}
            {` · created ${format.dateTime(task.createdAt)}`}
          </>
        }
      />
      <Section title="What to do">
        <pre className="bg-muted overflow-x-auto rounded-md p-4 font-mono text-sm whitespace-pre-wrap">
          {task.instructions}
        </pre>
      </Section>
      {task.status === "open" ? (
        me.isApprover ? (
          <CloseTask task={task} />
        ) : null
      ) : (
        <Card>
          <CardContent>
            <Details className="sm:grid-cols-1 lg:grid-cols-1">
              <Detail label="Closed">
                {task.completedAt ? format.dateTime(task.completedAt) : "—"}
                {task.completedBy ? ` by ${task.completedBy}` : ""}
              </Detail>
              {task.note ? (
                <Detail label="Note">
                  <span className="whitespace-pre-line">{task.note}</span>
                </Detail>
              ) : null}
            </Details>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
