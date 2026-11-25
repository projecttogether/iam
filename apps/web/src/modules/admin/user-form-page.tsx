import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import {
  ROLES,
  userInputSchema,
  type ActionResult,
  type Ref,
  type UserInput,
  type UserRow,
} from "@iam/shared/api/iam";
import { ROLE_LABELS, type Role } from "@iam/shared/labels";
import { api, ApiError, errorMessage } from "@/lib/api";
import { otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { useRecordTitle } from "@/app/record-name";
import { CheckboxField, FormActions, FormErrors, SelectField, TextField } from "@/components/form-fields";
import { refresh, userOptionsQuery, userQuery } from "./api";

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

/** Add an app user (`id` undefined) or edit one: email, name, role, active, person. */
export function UserFormPage({ id }: { id?: number }) {
  const user = useQuery({ ...userQuery(id ?? 0), enabled: id !== undefined });
  const options = useQuery(userOptionsQuery);
  useRecordTitle(`/admin/users/${id}`, id === undefined ? undefined : user.data?.email);
  if (id !== undefined && user.isError)
    return <ErrorState error={user.error} onRetry={() => void user.refetch()} />;
  if (options.isError) return <ErrorState error={options.error} onRetry={() => void options.refetch()} />;
  if ((id !== undefined && user.isPending) || options.isPending) return <LoadingState />;
  return <UserForm user={id === undefined ? null : (user.data ?? null)} people={options.data.people} />;
}

function UserForm({ user, people }: { user: UserRow | null; people: Ref[] }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [email, setEmail] = useState(user?.email ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "viewer");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [personId, setPersonId] = useState(user?.person ? String(user.person.id) : "");
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (input: UserInput) =>
      user ? api.put<ActionResult>(`/users/${user.id}`, input) : api.post<ActionResult>("/users", input),
    onSuccess: async (result) => {
      toast.success(result.message);
      await navigate({ to: "/admin/users" });
      await refresh(client, [["users"], ["audit"], ["me"]]);
    },
    onError: (error) => {
      setErrors(serverFieldErrors(error));
      // E.g. 409: "You cannot remove your own admin access."
      if (!(error instanceof ApiError && error.status === 422)) toast.error(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: UserInput = {
      email,
      displayName,
      role,
      isActive,
      personId: personId ? Number(personId) : null,
    };
    const invalid = validate(userInputSchema, input);
    setErrors(invalid ?? {});
    if (!invalid) save.mutate(input);
  };

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={user ? `Edit ${user.email}` : "Add user"}
        description={
          user?.roleSource === "provider"
            ? "The role comes from a group claim of the sign-in provider and is updated at each sign-in. Changing it here sets it locally."
            : undefined
        }
      />
      <form onSubmit={submit} noValidate className="grid gap-4">
        <Card>
          <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <TextField
              id="email"
              label="Email"
              type="email"
              hint="The address the sign-in provider confirms. The first sign-in links the account."
              value={email}
              onChange={setEmail}
              error={errors.email}
              maxLength={254}
              autoComplete="off"
              required
            />
            <TextField
              id="display-name"
              label="Display name"
              value={displayName}
              onChange={setDisplayName}
              error={errors.displayName}
              maxLength={200}
            />
            <SelectField
              id="role"
              label="Role"
              value={role}
              onChange={(value) => setRole(value as Role)}
              options={ROLE_OPTIONS}
              error={errors.role}
            />
            <SelectField
              id="person"
              label="Person"
              hint="Offboarding this person also turns off their app access."
              value={personId}
              onChange={setPersonId}
              options={people.map((person) => ({ value: String(person.id), label: person.name }))}
              empty="—"
              error={errors.personId}
            />
            <CheckboxField
              id="active"
              label="Active"
              checked={isActive}
              onChange={setIsActive}
              error={errors.isActive}
            />
          </CardContent>
        </Card>
        <FormErrors messages={otherErrors(errors, /^(email|displayName|role|personId|isActive)$/)} />
        <FormActions pending={save.isPending} cancelTo="/admin/users" />
      </form>
    </Page>
  );
}
