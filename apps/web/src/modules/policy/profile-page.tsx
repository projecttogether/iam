import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { PERSON_STATUS_LABELS, PERSON_TYPE_LABELS } from "@iam/shared/labels";
import { useMe } from "@/hooks/use-me";
import { useRecordTitle } from "@/app/record-name";
import { Empty, TextLink } from "@/components/lists";
import { StatusBadge, ToneBadge } from "@/components/status";
import { DeleteButton } from "@/components/delete-button";
import { profileQuery, refreshPolicy } from "./api";

/** An access profile: what it grants and who has it; admins edit or delete it. */
export function ProfilePage({ id }: { id: number }) {
  const me = useMe();
  const navigate = useNavigate();
  const client = useQueryClient();
  const query = useQuery(profileQuery(id));
  useRecordTitle(`/profiles/${id}`, query.data?.name);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const profile = query.data;
  const defaultFor = profile.defaultFor.map((type) => PERSON_TYPE_LABELS[type] ?? type).join(", ");
  return (
    <Page>
      <PageHeader
        title={profile.name}
        description={
          profile.description || defaultFor ? (
            <>
              {profile.description ? <span className="block">{profile.description}</span> : null}
              {defaultFor ? <span className="block text-xs">Default for: {defaultFor}</span> : null}
            </>
          ) : undefined
        }
        actions={
          me.isAdmin ? (
            <>
              <Button asChild variant="outline">
                <Link to={`/profiles/${id}/edit`}>Edit</Link>
              </Button>
              <DeleteButton
                path={`/profiles/${id}`}
                title={`Delete ${profile.name}?`}
                description="Only a profile that nobody has can be deleted."
                onDeleted={async () => {
                  await navigate({ to: "/profiles" });
                  client.removeQueries({ queryKey: ["profiles", id] });
                  await refreshPolicy(client);
                }}
              />
            </>
          ) : null
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Grants</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {profile.grants.length === 0 ? (
              <Empty>This profile grants nothing yet.</Empty>
            ) : (
              <Table scrollLabel="Grants">
                <TableBody>
                  {profile.grants.map((grant) => (
                    <TableRow key={grant.connection.id}>
                      <TableCell className="align-top font-medium">
                        {me.isAdmin ? (
                          <TextLink to={`/admin/connections/${grant.connection.id}`}>
                            {grant.connection.name}
                          </TextLink>
                        ) : (
                          grant.connection.name
                        )}
                        {grant.connection.enabled ? null : (
                          <>
                            {" "}
                            <Badge variant="outline">off</Badge>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-normal">
                        {grant.groups.length === 0
                          ? "Account only"
                          : grant.groups.map((group, index) => (
                              <span key={group.id}>
                                {group.label}
                                {group.missing ? (
                                  <>
                                    {" "}
                                    <ToneBadge tone="danger">missing</ToneBadge>
                                  </>
                                ) : null}
                                {index < grant.groups.length - 1 ? ", " : ""}
                              </span>
                            ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>People</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {profile.people.length === 0 ? (
              <Empty>Nobody has this profile.</Empty>
            ) : (
              <Table scrollLabel="People">
                <TableBody>
                  {profile.people.map((person) => (
                    <TableRow key={person.id}>
                      <TableCell>
                        <TextLink to={`/people/${person.id}`}>{person.name}</TextLink>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{person.team ?? ""}</TableCell>
                      <TableCell>
                        <StatusBadge value={person.status} labels={PERSON_STATUS_LABELS} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
