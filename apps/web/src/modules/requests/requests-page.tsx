import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  IDENTITY_REQUEST_STATUS_LABELS,
  PERSON_TYPE_LABELS,
  type IdentityRequestStatus,
} from "@iam/shared/labels";
import { useFormatter } from "@/lib/format";
import { StatusBadge } from "@/components/status";
import { Empty, PageControls, TextLink } from "@/components/lists";
import { requestsQuery, type RequestsSearch } from "./api";

const STATUSES = Object.entries(IDENTITY_REQUEST_STATUS_LABELS) as [IdentityRequestStatus, string][];

/** /requests: identity requests from other apps, open ones first. */
export function RequestsPage({
  search,
  onSearch,
}: {
  search: RequestsSearch;
  onSearch: (search: RequestsSearch) => void;
}) {
  const format = useFormatter();
  const query = useQuery(requestsQuery(search));
  const status = search.status ?? "open";
  return (
    <Page>
      <PageHeader
        title="Requests"
        description="Other apps, such as Helpdesk, ask for new people here. Approvers add the person, link one who is already here, or reject the request."
      />
      <div>
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(event) =>
            onSearch({
              status:
                event.target.value === "open"
                  ? undefined
                  : (event.target.value as IdentityRequestStatus | "all"),
            })
          }
        >
          {STATUSES.map(([value, label]) => (
            <NativeSelectOption key={value} value={value}>
              {label}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="all">All</NativeSelectOption>
        </NativeSelect>
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <Empty>
          {status === "open"
            ? "No open requests. Admin › Settings chooses which person types other apps may request."
            : "No requests."}
        </Empty>
      ) : (
        <>
          <Card className="py-0">
            <Table scrollLabel="Requests">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Person</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <TextLink to={`/requests/${request.id}`}>{request.name}</TextLink>
                    </TableCell>
                    <TableCell>{PERSON_TYPE_LABELS[request.personType]}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {request.startDate ? format.date(request.startDate) : "—"}
                    </TableCell>
                    <TableCell>{request.requestedBy || "—"}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {format.dateTime(request.createdAt)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={request.status} labels={IDENTITY_REQUEST_STATUS_LABELS} />
                    </TableCell>
                    <TableCell>
                      {request.person ? (
                        <TextLink to={`/people/${request.person.id}`}>{request.person.name}</TextLink>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <PageControls
            data={query.data}
            onPage={(page) => onSearch({ ...search, page: page > 1 ? page : undefined })}
          />
        </>
      )}
    </Page>
  );
}
