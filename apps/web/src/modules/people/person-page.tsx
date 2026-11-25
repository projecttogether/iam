import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ACCOUNT_STATUS_LABELS,
  PERSON_STATUS_LABELS,
  PERSON_TYPE_LABELS,
  type WorkflowKind,
} from "@iam/shared/labels";
import type { AccessRow, PersonDetail } from "@iam/shared/api/iam";
import { useMe } from "@/hooks/use-me";
import { useAction } from "@/hooks/use-action";
import { useFormatter } from "@/lib/format";
import { useRecordTitle } from "@/app/record-name";
import { Detail, Details, Section } from "@/components/detail";
import { StatusBadge, ToneBadge } from "@/components/status";
import { Empty, EventsTable, JobsTable, TasksTable, TextLink, WorkflowsTable } from "@/components/lists";
import { personQuery } from "./api";

/** Edit, start a workflow, archive: what an approver may do now. */
function Actions({ person }: { person: PersonDetail }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<"offboarding" | "archive" | null>(null);
  // Starting a workflow leads to it, as in the Django version.
  const start = useAction({ onDone: (result) => void navigate({ to: `/workflows/${result.id}` }) });
  const archive = useAction();
  const startKind = (kind: WorkflowKind) => start.mutateAsync({ path: `/people/${person.id}/start/${kind}` });
  return (
    <>
      <Button variant="outline" asChild>
        <Link to={`/people/${person.id}/edit`}>Edit</Link>
      </Button>
      {person.can.onboard ? (
        <Button
          disabled={start.isPending}
          onClick={() => void startKind("onboarding").catch(() => undefined)}
        >
          Start onboarding
        </Button>
      ) : null}
      {person.can.update ? (
        <Button
          variant="outline"
          disabled={start.isPending}
          onClick={() => void startKind("access_update").catch(() => undefined)}
        >
          Apply access
        </Button>
      ) : null}
      {person.can.offboard ? (
        <Button variant="destructive" disabled={start.isPending} onClick={() => setConfirm("offboarding")}>
          Start offboarding
        </Button>
      ) : null}
      {person.can.archive ? (
        <Button variant="outline" disabled={archive.isPending} onClick={() => setConfirm("archive")}>
          Archive
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm === "offboarding"}
        onOpenChange={(open) => setConfirm(open ? "offboarding" : null)}
        title={`Start offboarding of ${person.name}?`}
        description="Offboarding disables every known account of the person in the connected apps and turns off their app user. It cannot be cancelled."
        confirmLabel="Start offboarding"
        destructive
        onConfirm={() => startKind("offboarding")}
      />
      <ConfirmDialog
        open={confirm === "archive"}
        onOpenChange={(open) => setConfirm(open ? "archive" : null)}
        title={`Archive ${person.name}?`}
        description="Archived people no longer show in the people list; a search or the status filter still finds them."
        confirmLabel="Archive"
        onConfirm={() => archive.mutateAsync({ path: `/people/${person.id}/archive` })}
      />
    </>
  );
}

function ProfileCard({ person }: { person: PersonDetail }) {
  const format = useFormatter();
  return (
    <Section title="Profile">
      <Details className="lg:grid-cols-2">
        <Detail label="Work email">{person.workEmail ?? "—"}</Detail>
        <Detail label="Login name">
          {person.loginName ? <span className="font-mono">{person.loginName}</span> : "—"}
        </Detail>
        <Detail label="Personal email">{person.personalEmail || "—"}</Detail>
        <Detail label="Manager">
          {person.manager ? (
            <TextLink to={`/people/${person.manager.id}`}>{person.manager.name}</TextLink>
          ) : (
            "—"
          )}
        </Detail>
        <Detail label="Access profile">
          {person.accessProfile ? (
            <TextLink to={`/profiles/${person.accessProfile.id}`}>{person.accessProfile.name}</TextLink>
          ) : (
            <ToneBadge tone="warn">none</ToneBadge>
          )}
        </Detail>
        <Detail label="Start date">{person.startDate ? format.date(person.startDate) : "—"}</Detail>
        <Detail label="Last day">{person.endDate ? format.date(person.endDate) : "—"}</Detail>
        <Detail label="Source">
          {person.source ? (
            <>
              {person.source.connection}{" "}
              <span className="text-muted-foreground font-mono text-xs">{person.source.id}</span>
            </>
          ) : (
            "Added in this app"
          )}
        </Detail>
      </Details>
      {person.notes ? (
        <p className="text-muted-foreground text-sm whitespace-pre-line">{person.notes}</p>
      ) : null}
    </Section>
  );
}

function ShouldHave({ grant }: { grant: AccessRow["grant"] }) {
  if (!grant) return <span className="text-muted-foreground">No access</span>;
  return (
    <>
      Account
      {grant.groups.length > 0 ? (
        <div className="text-muted-foreground text-xs">
          {grant.groups.map((group, index) => (
            <span key={group.label}>
              {group.label} <span title={group.reasons.join(", ")}>({group.reasons.join(", ")})</span>
              {index < grant.groups.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function AccessCard({ rows }: { rows: AccessRow[] }) {
  const format = useFormatter();
  return (
    <Section
      title="Access"
      description="What the access profile and team grant, next to the accounts the app last saw."
    >
      {rows.length === 0 ? (
        <Empty>No access granted and no accounts known.</Empty>
      ) : (
        <Table scrollLabel="Access">
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Should have</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.connection.id}>
                <TableCell>{row.connection.name}</TableCell>
                <TableCell className="whitespace-normal">
                  <ShouldHave grant={row.grant} />
                </TableCell>
                <TableCell className="font-mono text-xs">{row.account?.label || "—"}</TableCell>
                <TableCell>
                  {row.account ? (
                    <StatusBadge value={row.account.status} labels={ACCOUNT_STATUS_LABELS} />
                  ) : (
                    <span className="text-muted-foreground text-xs">none known</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {row.account?.observedAt ? format.dateTime(row.account.observedAt) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** /people/$personId: the person's profile, access, workflows, tasks and history. */
export function PersonPage({ id }: { id: number }) {
  const me = useMe();
  const query = useQuery(personQuery(id));
  useRecordTitle(`/people/${id}`, query.data?.name);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const person = query.data;
  const lastDayPassed = person.endDate !== null && person.endDate < person.today && person.can.onboard;
  return (
    <Page>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {person.name} <StatusBadge value={person.status} labels={PERSON_STATUS_LABELS} />
          </span>
        }
        description={
          <>
            {PERSON_TYPE_LABELS[person.personType]}
            {person.jobTitle ? ` · ${person.jobTitle}` : ""}
            {person.team ? (
              <>
                {" · "}
                <TextLink to={`/teams/${person.team.id}`}>{person.team.name}</TextLink>
              </>
            ) : null}
          </>
        }
        actions={me.isApprover ? <Actions person={person} /> : null}
      />
      {person.onboardingPaused && person.status === "planned" ? (
        <Alert>
          <Info />
          <AlertDescription>
            The last onboarding was cancelled, so the schedule does not start it again. Change the start date
            or the access profile, or start the onboarding by hand.
          </AlertDescription>
        </Alert>
      ) : null}
      {lastDayPassed ? (
        <Alert variant="destructive">
          <AlertDescription>
            The last day has passed. Clear or change it before onboarding, or the schedule offboards{" "}
            {person.firstName} right after.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ProfileCard person={person} />
        <Section title="Open work">
          <JobsTable jobs={person.openJobs} showPerson={false} />
        </Section>
      </div>
      <AccessCard rows={person.accessRows} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Workflows">
          <WorkflowsTable workflows={person.workflows} showPerson={false} />
        </Section>
        <Section title="Tasks">
          <TasksTable tasks={person.tasks} showPerson={false} />
        </Section>
      </div>
      <Section title="History">
        <EventsTable events={person.events} />
      </Section>
    </Page>
  );
}
