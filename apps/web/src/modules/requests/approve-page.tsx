import { useQuery } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { IDENTITY_REQUEST_STATUS_LABELS } from "@iam/shared/labels";
import type { IdentityRequestDetail } from "@iam/shared/api/iam";
import { useRecordTitle } from "@/app/record-name";
import { Empty, TextLink } from "@/components/lists";
import { PersonForm, type PersonFormValues } from "@/modules/people/person-form";
import { personOptionsQuery } from "@/modules/people/api";
import { requestQuery } from "./api";

/** The person form's values from a request: what was requested, and where it came from in the notes. */
export function valuesFromRequest(request: IdentityRequestDetail): Partial<PersonFormValues> {
  const from = [
    `Identity request ${request.externalId}`,
    request.requestedByName || request.requestedByEmail
      ? `from ${request.requestedByName || request.requestedByEmail}`
      : "",
    request.externalUrl ? `(${request.externalUrl})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    firstName: request.firstName,
    lastName: request.lastName,
    personalEmail: request.personalEmail,
    jobTitle: request.jobTitle,
    personType: request.personType,
    teamId: request.team ? String(request.team.id) : "",
    managerId: request.manager ? String(request.manager.id) : "",
    startDate: request.startDate ?? "",
    endDate: request.endDate ?? "",
    notes: request.notes ? `${from}.\n\n${request.notes}` : `${from}.`,
  };
}

/** /requests/$requestId/approve: the person form, prefilled from the request. */
export function ApproveRequestPage({ id }: { id: number }) {
  const request = useQuery(requestQuery(id));
  const options = useQuery(personOptionsQuery());
  useRecordTitle(`/requests/${id}`, request.data?.name);
  if (request.isPending || options.isPending) return <LoadingState />;
  if (request.isError) return <ErrorState error={request.error} onRetry={() => void request.refetch()} />;
  if (options.isError) return <ErrorState error={options.error} onRetry={() => void options.refetch()} />;
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={`Add ${request.data.name}`}
        description="Check and complete what was requested, e.g. the work email and the access profile. Saving adds the person and approves the request."
      />
      {request.data.status === "open" ? (
        <PersonForm options={options.data} request={{ id, initial: valuesFromRequest(request.data) }} />
      ) : (
        <Empty>
          This request is {IDENTITY_REQUEST_STATUS_LABELS[request.data.status].toLowerCase()}.{" "}
          <TextLink to={`/requests/${id}`}>Back to the request</TextLink>
        </Empty>
      )}
    </Page>
  );
}
