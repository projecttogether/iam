import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMe } from "@/hooks/use-me";
import { Empty, TextLink } from "@/components/lists";
import { truncate } from "@/lib/text";
import { teamsQuery } from "./api";

/** Teams with their member count and groups. */
export function TeamsPage() {
  const me = useMe();
  const query = useQuery(teamsQuery);
  return (
    <Page>
      <PageHeader
        title="Teams"
        description="Members join the team's groups in every app their access profile gives them an account in."
        actions={
          me.isAdmin ? (
            <Button asChild>
              <Link to="/teams/new">Add team</Link>
            </Button>
          ) : null
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Card>
          <CardContent>
            {query.data.length === 0 ? (
              <Empty>No teams yet.</Empty>
            ) : (
              <Table scrollLabel="Teams">
                <TableHeader>
                  <TableRow>
                    <TableHead>Team</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Groups</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.map((team) => (
                    <TableRow key={team.id}>
                      <TableCell className="whitespace-normal">
                        <TextLink to={`/teams/${team.id}`}>{team.name}</TextLink>
                        {team.description ? (
                          <div className="text-muted-foreground text-xs">
                            {truncate(team.description, 100)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular-nums">{team.memberCount}</TableCell>
                      <TableCell className="text-sm whitespace-normal">
                        {team.groups.length === 0
                          ? "—"
                          : team.groups.map((group, index) => (
                              <div key={`${index}:${group.connection}:${group.label}`}>
                                {group.connection}: {group.label}
                              </div>
                            ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
