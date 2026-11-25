import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { WORKFLOW_KIND_LABELS, WORKFLOW_STATUS_LABELS } from "@iam/shared/labels";
import type { WorkflowDetail } from "@iam/shared/api/iam";
import { useMe } from "@/hooks/use-me";
import { useAction } from "@/hooks/use-action";
import { useFormatter } from "@/lib/format";
import { useRecordTitle } from "@/app/record-name";
import { Section } from "@/components/detail";
import { StatusBadge } from "@/components/status";
import { Empty, JobsTable, TasksTable, TextLink } from "@/components/lists";
import { workflowQuery } from "./api";

/** Approvers cancel an open onboarding or access update; offboarding cannot be cancelled. */
function CancelWorkflow({ workflow }: { workflow: WorkflowDetail }) {
  const cancel = useAction();
  return (
    <div className="grid justify-items-end gap-1">
      <Button
        variant="destructive"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate({ path: `/workflows/${workflow.id}/cancel` })}
      >
        Cancel workflow
      </Button>
      {workflow.kind === "onboarding" ? (
        <p className="text-muted-foreground max-w-xs text-right text-xs">
          The schedule does not start a cancelled onboarding again until the start date or the access profile
          changes.
        </p>
      ) : null}
    </div>
  );
}

/** /workflows/$workflowId: the jobs, the access captured at the start, and the tasks. */
export function WorkflowPage({ id }: { id: number }) {
  const me = useMe();
  const format = useFormatter();
  const query = useQuery(workflowQuery(id));
  const workflow = query.data;
  useRecordTitle(
    `/workflows/${id}`,
    workflow ? `${WORKFLOW_KIND_LABELS[workflow.kind]} of ${workflow.person.name}` : undefined,
  );
  if (query.isPending) return <LoadingState />;
  if (query.isError || !workflow)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const cancellable = me.isApprover && workflow.isOpen && workflow.kind !== "offboarding";
  return (
    <Page>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {WORKFLOW_KIND_LABELS[workflow.kind]} of{" "}
              <TextLink to={`/people/${workflow.person.id}`}>{workflow.person.name}</TextLink>
            </span>
            <StatusBadge value={workflow.status} labels={WORKFLOW_STATUS_LABELS} />
          </span>
        }
        description={
          <>
            Started {format.dateTime(workflow.createdAt)} by {workflow.createdBy ?? "the schedule"}
            {workflow.reason ? ` · ${workflow.reason}` : ""}
            {workflow.finishedAt ? ` · finished ${format.dateTime(workflow.finishedAt)}` : ""}
          </>
        }
        actions={cancellable ? <CancelWorkflow workflow={workflow} /> : null}
      />
      {workflow.status === "cancelled" && workflow.tooLate ? (
        <Alert>
          <AlertDescription>This workflow was cancelled while jobs ran. {workflow.tooLate}</AlertDescription>
        </Alert>
      ) : null}
      <Section title="Jobs">
        <JobsTable jobs={workflow.jobs} showPerson={false} />
      </Section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Desired access when started">
          {workflow.desired.length === 0 ? (
            <Empty>No access: every known account is disabled.</Empty>
          ) : (
            <Table>
              <TableBody>
                {workflow.desired.map((grant) => (
                  <TableRow key={grant.connection}>
                    <TableCell className="font-medium">{grant.connection}</TableCell>
                    <TableCell className="whitespace-normal">
                      {grant.groups.length > 0 ? grant.groups.join(", ") : "Account only"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
        <Section title="Tasks">
          <TasksTable tasks={workflow.tasks} showPerson={false} />
        </Section>
      </div>
    </Page>
  );
}
