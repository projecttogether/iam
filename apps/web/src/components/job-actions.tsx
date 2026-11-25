import { Button } from "@/components/ui/button";
import type { JobRow } from "@iam/shared/api/iam";
import { useMe } from "@/hooks/use-me";
import { useAction } from "@/hooks/use-action";

/**
 * What may happen to a job now: approvers retry a failed one, admins approve
 * or reject a held removal. `compact`: the small buttons of a table row.
 */
export function JobActions({
  job,
  compact = false,
}: {
  job: Pick<JobRow, "id" | "status">;
  compact?: boolean;
}) {
  const me = useMe();
  const action = useAction();
  const run = (path: "retry" | "approve" | "reject") => action.mutate({ path: `/jobs/${job.id}/${path}` });
  const size = compact ? "xs" : "default";
  return (
    <>
      {me.isApprover && job.status === "failed" ? (
        <Button
          size={size}
          variant={compact ? "outline" : "default"}
          disabled={action.isPending}
          onClick={() => run("retry")}
        >
          Retry
        </Button>
      ) : null}
      {me.isAdmin && job.status === "held" ? (
        <>
          <Button size={size} disabled={action.isPending} onClick={() => run("approve")}>
            {compact ? "Approve" : "Approve removal"}
          </Button>
          <Button size={size} variant="destructive" disabled={action.isPending} onClick={() => run("reject")}>
            Reject
          </Button>
        </>
      ) : null}
    </>
  );
}
