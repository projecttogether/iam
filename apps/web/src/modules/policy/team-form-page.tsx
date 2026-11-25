import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import {
  teamInputSchema,
  type ActionResult,
  type GroupConnection,
  type TeamDetail,
  type TeamInput,
} from "@iam/shared/api/iam";
import { api, ApiError, errorMessage } from "@/lib/api";
import { otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { useRecordTitle } from "@/app/record-name";
import { FormActions, FormErrors, TextareaField, TextField } from "@/components/form-fields";
import { GroupPicker } from "./group-picker";
import { groupConnectionsQuery, refreshPolicy, teamQuery } from "./api";

/** Add a team (`id` undefined) or edit one: name, description and its groups. */
export function TeamFormPage({ id }: { id?: number }) {
  const team = useQuery({ ...teamQuery(id ?? 0), enabled: id !== undefined });
  const connections = useQuery(groupConnectionsQuery);
  useRecordTitle(`/teams/${id}`, id === undefined ? undefined : team.data?.name);
  if (id !== undefined && team.isError)
    return <ErrorState error={team.error} onRetry={() => void team.refetch()} />;
  if (connections.isError)
    return <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />;
  if ((id !== undefined && team.isPending) || connections.isPending) return <LoadingState />;
  return <TeamForm team={id === undefined ? null : (team.data ?? null)} connections={connections.data} />;
}

function TeamForm({ team, connections }: { team: TeamDetail | null; connections: GroupConnection[] }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [groupIds, setGroupIds] = useState<ReadonlySet<number>>(() => new Set(team?.groupIds ?? []));
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (input: TeamInput) =>
      team ? api.put<ActionResult>(`/teams/${team.id}`, input) : api.post<ActionResult>("/teams", input),
    onSuccess: async (result) => {
      toast.success(result.message);
      await navigate({ to: `/teams/${result.id ?? team?.id}` });
      await refreshPolicy(client);
    },
    onError: (error) => {
      setErrors(serverFieldErrors(error));
      if (!(error instanceof ApiError && error.status === 422)) toast.error(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Only groups the picker shows: one that is no longer listed in its app drops out (as in the Django version).
    const shown = new Set(connections.flatMap((connection) => connection.groups.map((group) => group.id)));
    const input: TeamInput = {
      name,
      description,
      groupIds: [...groupIds].filter((groupId) => shown.has(groupId)),
    };
    const invalid = validate(teamInputSchema, input);
    setErrors(invalid ?? {});
    if (!invalid) save.mutate(input);
  };

  const toggle = (groupId: number, checked: boolean) =>
    setGroupIds((current) => {
      const next = new Set(current);
      if (checked) next.add(groupId);
      else next.delete(groupId);
      return next;
    });

  const title = team ? `Edit ${team.name}` : "Add team";
  return (
    <Page className="max-w-4xl">
      <PageHeader title={title} />
      <form onSubmit={submit} noValidate className="grid gap-4">
        <Card>
          <CardContent className="grid gap-5">
            <TextField
              id="name"
              label="Name"
              value={name}
              onChange={setName}
              error={errors.name}
              maxLength={200}
              required
            />
            <TextareaField
              id="description"
              label="Description"
              value={description}
              onChange={setDescription}
              error={errors.description}
              rows={3}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Team groups</h2>
            </CardTitle>
            <CardDescription>
              Members join these groups in every app where their access profile gives them an account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GroupPicker connections={connections} selected={groupIds} onToggle={toggle} />
          </CardContent>
        </Card>
        <FormErrors messages={otherErrors(errors, /^(name|description)$/)} />
        <FormActions pending={save.isPending} cancelTo={team ? `/teams/${team.id}` : "/teams"} />
      </form>
    </Page>
  );
}
