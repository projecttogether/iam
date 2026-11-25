import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { truncateWords } from "@/lib/text";
import { adaptersQuery } from "./api";

/** Add connection: the apps that can be connected, by kind. */
export function ChooseAdapterPage() {
  const query = useQuery(adaptersQuery);
  return (
    <Page>
      <PageHeader
        title="Add connection"
        description="Choose what to connect. Every setting can be changed later."
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        query.data
          .filter((section) => section.adapters.length > 0)
          .map((section) => (
            <section key={section.kind} className="grid gap-3">
              <h2 className="text-lg font-semibold">{section.label}</h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {section.adapters.map((adapter) => (
                  <li key={adapter.slug} className="grid">
                    <Link
                      to={`/admin/connections/new/${adapter.slug}`}
                      className="bg-card hover:bg-accent/40 focus-visible:ring-ring/50 grid content-start gap-1.5 rounded-xl border p-4 transition-colors outline-none focus-visible:ring-[3px]"
                    >
                      <h3 className="font-medium">{adapter.name}</h3>
                      <p className="text-muted-foreground text-sm">
                        {truncateWords(adapter.description, 40)}
                      </p>
                      {adapter.kind === "provisioning" ? (
                        <p className="text-sm">
                          {adapter.supportsWrite ? "Creates and disables accounts" : "Changes become tasks"}
                          {adapter.supportsGroups ? ` · ${adapter.groupLabel}` : ""}
                        </p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
      )}
    </Page>
  );
}
