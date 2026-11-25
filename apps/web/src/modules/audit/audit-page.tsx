import { useState, type FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import type { EventRow, Paged } from "@iam/shared/api/iam";
import { api } from "@/lib/api";
import { EventsTable, PageControls } from "@/components/lists";

export type AuditSearch = { q?: string; page?: number };

/** The audit log has pages of 100. */
const PAGE_SIZE = 100;

export const auditQuery = (search: AuditSearch) => ({
  queryKey: ["audit", search],
  queryFn: () => api.get<Paged<EventRow>>("/audit", search),
  placeholderData: keepPreviousData,
});

function SearchBox({ search, onSearch }: { search: AuditSearch; onSearch: (search: AuditSearch) => void }) {
  const [text, setText] = useState(search.q ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch({ q: text.trim() || undefined });
  };
  return (
    <form role="search" onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search"
        aria-label="Search"
        className="w-full sm:w-72"
      />
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}

/** /audit: every change by a person or the worker, newest first. */
export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (search: AuditSearch) => void;
}) {
  const query = useQuery(auditQuery(search));
  return (
    <Page>
      <PageHeader
        title="Audit log"
        description="Every change by a person or the worker. Secret values are never recorded."
      />
      <SearchBox key={search.q ?? ""} search={search} onSearch={onSearch} />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <Card className="py-0">
            <EventsTable events={query.data.items} showPerson />
          </Card>
          <PageControls
            data={query.data}
            pageSize={PAGE_SIZE}
            onPage={(page) => onSearch({ ...search, page: page > 1 ? page : undefined })}
          />
        </>
      )}
    </Page>
  );
}
