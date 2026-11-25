import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page, PageHeader } from "@/components/ui/page";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ActionResult, ApiKeyCreated, ApiKeyRow } from "@iam/shared/api/iam";
import { api, ApiError, errorMessage } from "@/lib/api";
import { serverFieldErrors } from "@/lib/form";
import { useFormatter } from "@/lib/format";
import { Empty } from "@/components/lists";
import { TextField } from "@/components/form-fields";
import { ToneBadge } from "@/components/status";
import { apiKeysQuery, refresh } from "./api";

/** Names a new key, then shows it once with a copy button. */
function NewKey() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const create = useMutation({
    mutationFn: (keyName: string) => api.post<ApiKeyCreated>("/api-keys", { name: keyName }),
    onSuccess: async (result) => {
      toast.success(result.message);
      setCreated(result);
      setName("");
      await refresh(client, [["api-keys"], ["audit"]]);
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.status === 422)) toast.error(errorMessage(error));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(name);
  };
  return (
    <Card>
      <CardContent className="grid gap-4">
        <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:w-80">
            <TextField
              id="api-key-name"
              label="Name"
              hint="Which app uses it, e.g. Helpdesk."
              value={name}
              onChange={setName}
              error={serverFieldErrors(create.error).name}
              maxLength={100}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending || name.trim() === ""} className="sm:mb-6">
            {create.isPending ? <Spinner /> : null}
            Create key
          </Button>
        </form>
        {created ? (
          <Alert>
            <AlertTitle>Copy the key for {created.apiKey.name} now</AlertTitle>
            <AlertDescription className="grid gap-2">
              <span>It is shown only this once. Store it in the other app&apos;s settings.</span>
              <SecretInput
                aria-label={`API key for ${created.apiKey.name}`}
                value={created.key}
                readOnly
                copyable
                inputClassName="font-mono"
              />
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Revoke({ apiKey }: { apiKey: ApiKeyRow }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const confirm = async () => {
    try {
      const result = await api.post<ActionResult>(`/api-keys/${apiKey.id}/revoke`);
      toast.success(result.message);
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
    await refresh(client, [["api-keys"], ["audit"]]);
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Revoke the key "${apiKey.name}"?`}
        description="Apps that use it can no longer send or read identity requests. This cannot be undone; create a new key instead."
        confirmLabel="Revoke"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}

/** /admin/api-keys: the keys other apps send identity requests with. */
export function ApiKeysPage() {
  const format = useFormatter();
  const query = useQuery(apiKeysQuery);
  return (
    <Page className="max-w-5xl">
      <PageHeader
        title="API keys"
        description="Other apps, such as Helpdesk, send identity requests with a key and read what became of them. A key can do nothing else. Admin › Settings chooses which person types they may request."
      />
      <NewKey />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Card>
          <CardContent>
            {query.data.length === 0 ? (
              <Empty>No keys yet.</Empty>
            ) : (
              <Table scrollLabel="API keys">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.map((apiKey) => (
                    <TableRow key={apiKey.id}>
                      <TableCell>{apiKey.name}</TableCell>
                      <TableCell className="font-mono text-sm">{apiKey.prefix}…</TableCell>
                      <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                        {format.dateTime(apiKey.createdAt)}
                        {apiKey.createdBy ? <div className="text-xs">by {apiKey.createdBy}</div> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                        {apiKey.lastUsedAt ? format.dateTime(apiKey.lastUsedAt) : "never"}
                      </TableCell>
                      <TableCell>
                        {apiKey.revokedAt ? (
                          <Badge variant="outline">Revoked</Badge>
                        ) : (
                          <ToneBadge tone="ok">Active</ToneBadge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {apiKey.revokedAt ? null : <Revoke apiKey={apiKey} />}
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
