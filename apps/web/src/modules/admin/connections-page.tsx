import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TextLink } from "@/components/lists";
import { useFormatter } from "@/lib/format";
import { shortMode } from "@/lib/text";
import { ConnectionState } from "./connection-parts";
import { connectionsQuery } from "./api";

/** The connected apps by kind: accounts and groups, people import, email. */
export function ConnectionsPage() {
  const format = useFormatter();
  const query = useQuery(connectionsQuery);
  return (
    <Page>
      <PageHeader
        title="Connections"
        description="The apps and services this app manages accounts in, imports people from, or sends email through."
        actions={
          <Button asChild>
            <Link to="/admin/connections/new">Add connection</Link>
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          {query.data.hasConnections ? null : (
            <Alert>
              <AlertDescription>
                Nothing connected yet. Add your directory first (for example Keycloak or Google Workspace),
                then an email connection for sign-in details and task notifications.
              </AlertDescription>
            </Alert>
          )}
          {query.data.sections
            .filter((section) => section.connections.length > 0)
            .map((section) => (
              <Card key={section.kind}>
                <CardHeader>
                  <CardTitle>
                    <h2>{section.label}</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table scrollLabel={section.label}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Mode</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Last check</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {section.connections.map((connection) => (
                        <TableRow key={connection.id}>
                          <TableCell>
                            <TextLink to={`/admin/connections/${connection.id}`}>{connection.name}</TextLink>
                          </TableCell>
                          <TableCell className="text-sm">{connection.adapterName}</TableCell>
                          <TableCell className="text-sm">
                            {connection.kind === "provisioning" ? shortMode(connection.mode) : "—"}
                          </TableCell>
                          <TableCell>
                            <ConnectionState enabled={connection.enabled} status={connection.status} />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {connection.checkedAt ? format.dateTime(connection.checkedAt) : "never"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
        </>
      )}
    </Page>
  );
}
