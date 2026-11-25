import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PERSON_STATUS_LABELS, PERSON_TYPE_LABELS, type PersonStatus } from "@iam/shared/labels";
import { useMe } from "@/hooks/use-me";
import { useFormatter } from "@/lib/format";
import { StatusBadge } from "@/components/status";
import { Empty, PageControls, TextLink } from "@/components/lists";
import { peopleQuery, personOptionsQuery, type PeopleSearch } from "./api";

const STATUSES = Object.entries(PERSON_STATUS_LABELS) as [PersonStatus, string][];

/** The search box; it applies on Enter or "Filter", the selects at once. */
function Filters({ search, onSearch }: { search: PeopleSearch; onSearch: (search: PeopleSearch) => void }) {
  const [text, setText] = useState(search.q ?? "");
  const teams = useQuery(personOptionsQuery()).data?.teams ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch({ ...search, q: text.trim() || undefined, page: undefined });
  };
  return (
    <form role="search" onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Name, email or username"
        aria-label="Search"
        className="w-full sm:w-72"
      />
      <NativeSelect
        aria-label="Status"
        value={search.status ?? ""}
        onChange={(event) =>
          onSearch({
            ...search,
            status: (event.target.value || undefined) as PersonStatus | undefined,
            page: undefined,
          })
        }
      >
        <NativeSelectOption value="">Not archived</NativeSelectOption>
        {STATUSES.map(([value, label]) => (
          <NativeSelectOption key={value} value={value}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Team"
        value={search.team ? String(search.team) : ""}
        onChange={(event) =>
          onSearch({
            ...search,
            team: event.target.value ? Number(event.target.value) : undefined,
            page: undefined,
          })
        }
      >
        <NativeSelectOption value="">All teams</NativeSelectOption>
        {teams.map((team) => (
          <NativeSelectOption key={team.id} value={String(team.id)}>
            {team.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button type="submit" variant="outline">
        Filter
      </Button>
    </form>
  );
}

/** /people: everyone whose access this app manages, filtered by the address. */
export function PeoplePage({
  search,
  onSearch,
}: {
  search: PeopleSearch;
  onSearch: (search: PeopleSearch) => void;
}) {
  const me = useMe();
  const format = useFormatter();
  const query = useQuery(peopleQuery(search));
  return (
    <Page>
      <PageHeader
        title="People"
        description="Everyone whose access this app manages."
        actions={
          me.isApprover ? (
            <Button asChild>
              <Link to="/people/new">Add person</Link>
            </Button>
          ) : null
        }
      />
      <Filters key={search.q ?? ""} search={search} onSearch={onSearch} />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <Empty>No people match.</Empty>
      ) : (
        <>
          <Card className="py-0">
            <Table scrollLabel="People">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Work email</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Access profile</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell>
                      <TextLink to={`/people/${person.id}`}>{person.name}</TextLink>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{person.workEmail ?? "—"}</TableCell>
                    <TableCell>{PERSON_TYPE_LABELS[person.personType]}</TableCell>
                    <TableCell>{person.team ?? "—"}</TableCell>
                    <TableCell>{person.accessProfile ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {person.startDate ? format.date(person.startDate) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {person.endDate ? format.date(person.endDate) : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={person.status} labels={PERSON_STATUS_LABELS} />
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
