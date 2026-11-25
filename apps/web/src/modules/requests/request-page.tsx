import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  IDENTITY_REQUEST_STATUS_LABELS,
  PERSON_STATUS_LABELS,
  PERSON_TYPE_LABELS,
  type PersonStatus,
} from "@iam/shared/labels";
import type { IdentityRequestDetail } from "@iam/shared/api/iam";
import { useMe } from "@/hooks/use-me";
import { useAction } from "@/hooks/use-action";
import { useFormatter } from "@/lib/format";
import { useRecordTitle } from "@/app/record-name";
import { Detail, Details, Section } from "@/components/detail";
import { TextareaField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status";
import { TextLink } from "@/components/lists";
import { peopleQuery } from "@/modules/people/api";
import { requestQuery } from "./api";

/** An address of the sending app, as a link that opens in a new tab. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

type Candidate = { id: number; name: string; workEmail: string | null };

/** A person by name, email or username (archived people too), for someone the suggestions miss. */
function FindPerson({ onChoose }: { onChoose: (person: Candidate) => void }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  // No previous results while a new search loads: a Link there would pick from the old search.
  const results = useQuery({
    ...peopleQuery({ q: search }),
    placeholderData: undefined,
    enabled: search !== "",
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(text.trim());
  };
  return (
    <div className="grid gap-3">
      <form role="search" onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Name, email or username"
          aria-label="Find another person"
          className="w-full sm:w-72"
        />
        <Button type="submit" variant="outline" disabled={text.trim() === ""}>
          Find
        </Button>
      </form>
      {search === "" ? null : results.isPending ? (
        <LoadingState />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : results.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No one matches.</p>
      ) : (
        <>
          <PeopleTable
            label="People found"
            people={results.data.items.map((person) => ({ ...person, reason: null }))}
            onChoose={onChoose}
          />
          {results.data.total > results.data.items.length ? (
            <p className="text-muted-foreground text-sm">
              {results.data.total} people match; the first {results.data.items.length} show. Search for more
              of the name or the email.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function PeopleTable(props: {
  label: string;
  people: (Candidate & { status: PersonStatus; reason: string | null })[];
  onChoose: (person: Candidate) => void;
}) {
  const withReason = props.people.some((person) => person.reason);
  return (
    <Table scrollLabel={props.label}>
      <TableHeader>
        <TableRow>
          <TableHead>Person</TableHead>
          <TableHead>Work email</TableHead>
          <TableHead>Status</TableHead>
          {withReason ? <TableHead>Why</TableHead> : null}
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.people.map((person) => (
          <TableRow key={person.id}>
            <TableCell>
              <TextLink to={`/people/${person.id}`}>{person.name}</TextLink>
            </TableCell>
            <TableCell className="text-muted-foreground">{person.workEmail ?? "—"}</TableCell>
            <TableCell>
              <StatusBadge value={person.status} labels={PERSON_STATUS_LABELS} />
            </TableCell>
            {withReason ? <TableCell className="text-sm">{person.reason}</TableCell> : null}
            <TableCell className="text-right">
              <Button variant="outline" size="sm" onClick={() => props.onChoose(person)}>
                Link
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * People who may be this person, and a search for anyone else: an approver
 * links one instead of adding a new person.
 */
function Matches({ request }: { request: IdentityRequestDetail }) {
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const link = useAction();
  return (
    <Section
      title="Already here?"
      description="Link a person who is already here, e.g. one Personio imported or someone who returns, to approve the request without adding a new person."
    >
      {request.matches.length > 0 ? (
        <PeopleTable label="Possible matches" people={request.matches} onChoose={setChosen} />
      ) : (
        <p className="text-muted-foreground text-sm">No one here has the same name or email.</p>
      )}
      <FindPerson onChoose={setChosen} />
      <ConfirmDialog
        open={chosen !== null}
        onOpenChange={(open) => {
          if (!open) setChosen(null);
        }}
        title={`Link the request to ${chosen?.name ?? ""}${chosen?.workEmail ? ` (${chosen.workEmail})` : ""}?`}
        description="The request counts as approved with this person. Nothing changes in the person's record; start onboarding or an access update from the person's page if needed."
        confirmLabel="Link"
        onConfirm={() =>
          link.mutateAsync({
            path: `/identity-requests/${request.id}/link`,
            body: { personId: chosen?.id },
          })
        }
      />
    </Section>
  );
}

/** Other requests that may be for the same person, e.g. sent from two tickets: a hint, never a block. */
function Duplicates({ request }: { request: IdentityRequestDetail }) {
  const format = useFormatter();
  if (request.duplicates.length === 0) return null;
  return (
    <Section
      title="Possible duplicate requests"
      description="Other requests that may be for the same person. If one is, reject this request with a reason such as “Duplicate of the request from …”."
    >
      <Table scrollLabel="Possible duplicate requests">
        <TableHeader>
          <TableRow>
            <TableHead>Request</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent with</TableHead>
            <TableHead>Received</TableHead>
            <TableHead>Why</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {request.duplicates.map((other) => (
            <TableRow key={other.id}>
              <TableCell>
                <TextLink to={`/requests/${other.id}`}>{other.name}</TextLink>
              </TableCell>
              <TableCell>
                <StatusBadge value={other.status} labels={IDENTITY_REQUEST_STATUS_LABELS} />
              </TableCell>
              <TableCell className="text-sm">{other.source ? `API key "${other.source}"` : "—"}</TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                {format.dateTime(other.createdAt)}
              </TableCell>
              <TableCell className="text-sm">{other.reason}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

/** Approvers add the person (a prefilled form) or reject the request with a reason. */
function Decide({ request }: { request: IdentityRequestDetail }) {
  const [reason, setReason] = useState("");
  const reject = useAction();
  return (
    <Section title="Decide">
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to={`/requests/${request.id}/approve`}>Add person…</Link>
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        Opens the person form with the requested details. Complete it (e.g. the work email); saving adds the
        person and approves the request. Onboarding then follows as for anyone added by hand.
      </p>
      <TextareaField
        id="reject-reason"
        label="Reason for rejecting"
        hint="The app that sent the request shows it to the people who asked."
        rows={3}
        maxLength={1000}
        value={reason}
        onChange={setReason}
      />
      <div>
        <Button
          variant="destructive"
          disabled={reject.isPending || reason.trim() === ""}
          onClick={() => reject.mutate({ path: `/identity-requests/${request.id}/reject`, body: { reason } })}
        >
          Reject request
        </Button>
      </div>
    </Section>
  );
}

/** /requests/$requestId: what was requested, and the decision. */
export function RequestPage({ id }: { id: number }) {
  const me = useMe();
  const format = useFormatter();
  const query = useQuery(requestQuery(id));
  const request = query.data;
  useRecordTitle(`/requests/${id}`, request?.name);
  if (query.isPending) return <LoadingState />;
  if (query.isError || !request)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const date = (value: string | null) => (value ? format.date(value) : "—");
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {request.name}
            <StatusBadge value={request.status} labels={IDENTITY_REQUEST_STATUS_LABELS} />
          </span>
        }
        description={`${PERSON_TYPE_LABELS[request.personType]} · received ${format.dateTime(request.createdAt)}`}
      />
      <Section title="Requested">
        <Details>
          <Detail label="First name">{request.firstName}</Detail>
          <Detail label="Last name">{request.lastName}</Detail>
          <Detail label="Person type">{PERSON_TYPE_LABELS[request.personType]}</Detail>
          <Detail label="Personal email">{request.personalEmail || "—"}</Detail>
          <Detail label="Job title">{request.jobTitle || "—"}</Detail>
          <Detail label="Team">{request.team?.name ?? "—"}</Detail>
          <Detail label="Manager">
            {request.manager ? (
              <TextLink to={`/people/${request.manager.id}`}>{request.manager.name}</TextLink>
            ) : (
              request.managerEmail || "—"
            )}
          </Detail>
          <Detail label="Start date">{date(request.startDate)}</Detail>
          <Detail label="End date">{date(request.endDate)}</Detail>
        </Details>
        {request.notes ? (
          <Details className="sm:grid-cols-1 lg:grid-cols-1">
            <Detail label="Notes">
              <span className="whitespace-pre-line">{request.notes}</span>
            </Detail>
          </Details>
        ) : null}
        <Details>
          <Detail label="Requested by">
            {request.requestedByName || "—"}
            {request.requestedByEmail ? (
              <div className="text-muted-foreground">{request.requestedByEmail}</div>
            ) : null}
          </Detail>
          <Detail label="Sent with">{request.source ? `API key "${request.source}"` : "—"}</Detail>
          <Detail label="Reference">
            {request.externalUrl ? (
              <ExternalLink href={request.externalUrl}>{request.externalId}</ExternalLink>
            ) : (
              request.externalId
            )}
          </Detail>
        </Details>
      </Section>
      {request.status === "open" ? (
        me.isApprover ? (
          <>
            <Duplicates request={request} />
            <Matches request={request} />
            <Decide request={request} />
          </>
        ) : null
      ) : (
        <Section title="Decision">
          <Details>
            <Detail label="Status">
              <StatusBadge value={request.status} labels={IDENTITY_REQUEST_STATUS_LABELS} />
            </Detail>
            <Detail label="When">
              {request.decidedAt ? format.dateTime(request.decidedAt) : "—"}
              {request.decidedBy ? ` by ${request.decidedBy}` : ""}
            </Detail>
            <Detail label="Person">
              {request.person ? (
                <TextLink to={`/people/${request.person.id}`}>{request.person.name}</TextLink>
              ) : (
                "—"
              )}
            </Detail>
            {request.decisionNote ? (
              <Detail label="Reason" className="sm:col-span-2 lg:col-span-3">
                <span className="whitespace-pre-line">{request.decisionNote}</span>
              </Detail>
            ) : null}
          </Details>
        </Section>
      )}
    </Page>
  );
}
