import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ConnectionDetail } from "@iam/shared/api/iam";
import {
  ACCOUNT_STATUS_LABELS,
  CONNECTION_MODE_LABELS,
  SYNC_KIND_LABELS,
  SYNC_STATUS_LABELS,
} from "@iam/shared/labels";
import { api } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { truncate } from "@/lib/text";
import { useRecordTitle } from "@/app/record-name";
import { Detail, Details } from "@/components/detail";
import { Empty, TextLink } from "@/components/lists";
import { StatusBadge, ToneBadge } from "@/components/status";
import { DeleteButton } from "@/components/delete-button";
import { ConnectionState } from "./connection-parts";
import { CONNECTION_QUERY_KEYS, connectionQuery, refresh, useActions } from "./api";

type Actions = ReturnType<typeof useActions>;

/** A button of the page header that runs an action and shows while it runs. */
function ActionButton(props: {
  actions: Actions;
  name: string;
  run: () => Promise<{ ok?: boolean; message: string }>;
  variant?: "default" | "outline";
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={props.variant ?? "outline"}
      disabled={props.actions.busy}
      onClick={() => void props.actions.run(props.name, props.run)}
    >
      {props.actions.pending(props.name) ? <Spinner /> : null}
      {props.children}
    </Button>
  );
}

/** A connection: its state, actions, settings, groups, accounts and recent reads. */
export function ConnectionPage({ id }: { id: number }) {
  const query = useQuery(connectionQuery(id));
  const actions = useActions(CONNECTION_QUERY_KEYS);
  useRecordTitle(`/admin/connections/${id}`, query.data?.name);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const connection = query.data;
  const path = `/admin/connections/${id}`;
  const apiPath = `/connections/${id}`;
  const adapter = connection.adapter;
  return (
    <Page>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span className="truncate">{connection.name}</span>
            <ConnectionState enabled={connection.enabled} status={connection.status} />
          </span>
        }
        description={
          (adapter?.name ?? connection.adapterName) +
          (connection.kind === "provisioning" ? ` · ${CONNECTION_MODE_LABELS[connection.mode]}` : "")
        }
        actions={
          <>
            <ActionButton actions={actions} name="test" run={() => api.post(`${apiPath}/test`)}>
              Test connection
            </ActionButton>
            {connection.canImportGroups ? (
              <ActionButton
                actions={actions}
                name="import-groups"
                run={() => api.post(`${apiPath}/import-groups`)}
              >
                Import {(adapter?.groupLabel ?? "Groups").toLowerCase()}
              </ActionButton>
            ) : null}
            {connection.kind === "hr_source" ? (
              <ActionButton actions={actions} name="sync" run={() => api.post(`${apiPath}/sync`)}>
                Import people now
              </ActionButton>
            ) : connection.canCompare ? (
              <ActionButton actions={actions} name="sync" run={() => api.post(`${apiPath}/sync`)}>
                Compare accounts now
              </ActionButton>
            ) : null}
            {adapter ? (
              <Button asChild variant="outline">
                <Link to={`${path}/edit`}>Edit</Link>
              </Button>
            ) : null}
            <ActionButton
              actions={actions}
              name="toggle"
              variant={connection.enabled ? "outline" : "default"}
              run={() => api.post(`${apiPath}/toggle`)}
            >
              {connection.enabled ? "Turn off" : "Turn on"}
            </ActionButton>
          </>
        }
      />
      <StatusMessage connection={connection} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SettingsCard connection={connection} />
        <UsedByCard connection={connection} />
      </div>
      {connection.supportsGroups ? <GroupsCard connection={connection} actions={actions} /> : null}
      {connection.kind === "provisioning" ? <AccountsCard connection={connection} /> : null}
      <ReadsCard connection={connection} />
      {connection.deletable ? <DeleteConnection connection={connection} /> : null}
    </Page>
  );
}

function StatusMessage({ connection }: { connection: ConnectionDetail }) {
  const format = useFormatter();
  if (!connection.statusMessage) return null;
  return (
    <Alert variant={connection.status === "ok" ? "default" : "destructive"}>
      <AlertDescription>
        <p className="break-words whitespace-pre-line">
          {connection.statusMessage}
          {connection.checkedAt ? (
            <span className="text-xs"> ({format.dateTime(connection.checkedAt)})</span>
          ) : null}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function SettingsCard({ connection }: { connection: ConnectionDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Settings</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {connection.settings.length === 0 && connection.secrets.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <Details className="lg:grid-cols-2">
            {connection.settings.map((setting) => (
              <Detail key={setting.label} label={setting.label}>
                {setting.kind === "bool" ? (
                  setting.value ? (
                    "yes"
                  ) : (
                    "no"
                  )
                ) : setting.value === null || setting.value === undefined || setting.value === "" ? (
                  "—"
                ) : (
                  <span className="whitespace-pre-line">{String(setting.value)}</span>
                )}
              </Detail>
            ))}
            {connection.secrets.map((secret) => (
              <Detail key={secret.label} label={secret.label}>
                {secret.saved ? (
                  <ToneBadge tone="ok">saved</ToneBadge>
                ) : (
                  <Badge variant="outline">not set</Badge>
                )}
              </Detail>
            ))}
          </Details>
        )}
      </CardContent>
    </Card>
  );
}

function UsedByCard({ connection }: { connection: ConnectionDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Used by</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {connection.grants.length === 0 ? (
          <Empty>No access profile grants this connection yet.</Empty>
        ) : (
          <ul className="grid gap-1 text-sm">
            {connection.grants.map((profile) => (
              <li key={profile.id}>
                <TextLink to={`/profiles/${profile.id}`}>{profile.name}</TextLink>
              </li>
            ))}
          </ul>
        )}
        {connection.kind === "hr_source" ? (
          <p className="text-muted-foreground text-sm">
            People imports run every {connection.syncIntervalMinutes} minutes while the connection is on.
          </p>
        ) : connection.canCompare ? (
          <p className="text-muted-foreground text-sm">
            Account comparisons run every {connection.syncIntervalMinutes} minutes while the connection is on
            (0 = never).
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GroupsCard({ connection, actions }: { connection: ConnectionDetail; actions: Actions }) {
  const format = useFormatter();
  const [name, setName] = useState("");
  const label = connection.adapter?.groupLabel ?? "Groups";
  const manual = connection.adapter?.manualGroups ?? false;
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (await actions.run("add-group", () => api.post(`/connections/${connection.id}/groups`, { name })))
      setName("");
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            {label}{" "}
            <span className="text-muted-foreground text-sm font-normal">{connection.groups.length}</span>
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {manual ? (
          <form onSubmit={(event) => void add(event)} className="flex flex-wrap gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              aria-label="Name"
              maxLength={255}
              className="w-full sm:w-64"
            />
            <Button type="submit" variant="outline" disabled={actions.busy}>
              {actions.pending("add-group") ? <Spinner /> : null}
              Add
            </Button>
          </form>
        ) : null}
        {connection.groups.length === 0 ? (
          <Empty>None yet.{manual ? "" : " Import them with the button above."}</Empty>
        ) : (
          <Table scrollLabel={label}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                {manual ? <TableHead className="w-0" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {connection.groups.map((group) => (
                <TableRow key={group.id}>
                  <TableCell className="whitespace-normal">
                    {group.label}
                    {group.missing ? (
                      <>
                        {" "}
                        <ToneBadge tone="danger">no longer listed</ToneBadge>
                      </>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {truncate(group.externalId, 40)}
                  </TableCell>
                  {manual ? (
                    <TableCell className="text-right">
                      {group.manual ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={actions.busy}
                          aria-label={`Remove ${group.label}`}
                          onClick={() =>
                            void actions.run(`remove-group-${group.id}`, () =>
                              api.delete(`/connections/${connection.id}/groups/${group.id}`),
                            )
                          }
                        >
                          {actions.pending(`remove-group-${group.id}`) ? <Spinner /> : null}
                          Remove
                        </Button>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {connection.groupsSyncedAt ? (
          <p className="text-muted-foreground text-sm">
            Imported {format.dateTime(connection.groupsSyncedAt)}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AccountsCard({ connection }: { connection: ConnectionDetail }) {
  const format = useFormatter();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            Accounts{" "}
            <span className="text-muted-foreground text-sm font-normal">{connection.accountCount}</span>
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {connection.accounts.length === 0 ? (
          <Empty>No accounts known yet.</Empty>
        ) : (
          <Table scrollLabel="Accounts">
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Person</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connection.accounts.map((account) => (
                <TableRow key={account.id}>
                  <TableCell className="font-mono text-xs">{account.label}</TableCell>
                  <TableCell>
                    {account.person ? (
                      <TextLink to={`/people/${account.person.id}`}>{account.person.name}</TextLink>
                    ) : (
                      <ToneBadge tone="warn">not linked</ToneBadge>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={account.status} labels={ACCOUNT_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {account.observedAt ? format.dateTime(account.observedAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {connection.accountCount > connection.accounts.length ? (
          <p className="text-muted-foreground text-sm">
            The first {connection.accounts.length} of {connection.accountCount}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReadsCard({ connection }: { connection: ConnectionDetail }) {
  const format = useFormatter();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Recent reads</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {connection.syncRuns.length === 0 ? (
          <Empty>Nothing read yet.</Empty>
        ) : (
          <Table scrollLabel="Recent reads">
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connection.syncRuns.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>{SYNC_KIND_LABELS[run.kind]}</TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {format.dateTime(run.startedAt)}
                    {run.triggeredBy ? ` · ${run.triggeredBy}` : ""}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={run.status} labels={SYNC_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-sm whitespace-normal">{run.error || run.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteConnection({ connection }: { connection: ConnectionDetail }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <div>
      <DeleteButton
        path={`/connections/${connection.id}`}
        label="Delete connection"
        title={`Delete ${connection.name}?`}
        description="Its settings, groups, accounts and reads are deleted too. This cannot be undone."
        onDeleted={async () => {
          await navigate({ to: "/admin/connections" });
          client.removeQueries({ queryKey: ["connections", connection.id] });
          await refresh(client, CONNECTION_QUERY_KEYS);
        }}
      />
    </div>
  );
}
