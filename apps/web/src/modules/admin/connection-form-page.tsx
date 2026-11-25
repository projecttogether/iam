import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { initialSecret, SecretField, secretPayload, type SecretValue } from "@/components/ui/secret-field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { cn } from "@/components/ui/utils";
import {
  connectionInputSchema,
  type ActionResult,
  type AdapterField,
  type AdapterInfo,
  type ConnectionForm,
  type ConnectionInput,
} from "@iam/shared/api/iam";
import { CONNECTION_MODE_LABELS, type ConnectionMode } from "@iam/shared/labels";
import { api, ApiError, errorMessage } from "@/lib/api";
import { otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { REPOSITORY_URL } from "@/lib/repository";
import { useRecordTitle } from "@/app/record-name";
import {
  CheckboxField,
  FormActions,
  FormErrors,
  SelectField,
  SwitchField,
  TextareaField,
  TextField,
} from "@/components/form-fields";
import { CONNECTION_QUERY_KEYS, adapterQuery, connectionFormQuery, refresh } from "./api";

/** The hint of a saved secret, as in the Django version. */
export const KEEP_SECRET_HELP = "Saved. Leave empty to keep it.";

const ENABLED_HELP =
  "Turned off, the app changes nothing there: onboarding skips it, offboarding creates a task, and the schedule does not read it.";

const MODES = (Object.entries(CONNECTION_MODE_LABELS) as [ConnectionMode, string][]).map(
  ([value, label]) => ({
    value,
    label,
  }),
);

/**
 * Add a connection of an adapter (`adapter`, its slug) or edit one (`id`):
 * name, mode, on or off, and the settings the adapter declares. Secrets are
 * write-only: the form never gets their values, only which are saved, and
 * sends only the ones entered.
 */
export function ConnectionFormPage(
  props: { adapter: string; id?: undefined } | { id: number; adapter?: undefined },
) {
  const edit = useQuery({ ...connectionFormQuery(props.id ?? 0), enabled: props.id !== undefined });
  const adapter = useQuery({ ...adapterQuery(props.adapter ?? ""), enabled: props.adapter !== undefined });
  const query = props.id !== undefined ? edit : adapter;
  useRecordTitle(
    props.id !== undefined ? `/admin/connections/${props.id}` : `/admin/connections/new/${props.adapter}`,
    props.id !== undefined ? edit.data?.name : adapter.data?.name,
  );
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (props.id !== undefined) return <ConnectionFormView id={props.id} initial={edit.data!} />;
  return <ConnectionFormView initial={newConnection(adapter.data!)} />;
}

/** The values of a new connection: the adapter's name and defaults, turned off. */
function newConnection(adapter: AdapterInfo): ConnectionForm {
  const settings: Record<string, unknown> = {};
  for (const field of adapter.fields) if (field.kind !== "secret") settings[field.name] = field.default;
  return { adapter, name: adapter.name, enabled: false, mode: "automatic", settings, savedSecrets: [] };
}

type SettingValue = string | boolean;

/** A setting as its input holds it: a bool as a boolean, everything else as text. */
function settingValue(field: AdapterField, value: unknown): SettingValue {
  if (field.kind === "bool") return value === true || value === "true";
  const text = value === null || value === undefined ? "" : String(value);
  // A choice always has one of its values, as the select shows (the first one without a value).
  if (field.kind === "choice" && !field.choices.some(([choice]) => choice === text))
    return field.choices[0]?.[0] ?? "";
  return text;
}

function ConnectionFormView({ id, initial }: { id?: number; initial: ConnectionForm }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const adapter = initial.adapter;
  const settingFields = adapter.fields.filter((field) => field.kind !== "secret");
  const secretFields = adapter.fields.filter((field) => field.kind === "secret");
  const [name, setName] = useState(initial.name);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<ConnectionMode>(initial.mode);
  const [settings, setSettings] = useState<Record<string, SettingValue>>(() =>
    Object.fromEntries(
      settingFields.map((field) => [field.name, settingValue(field, initial.settings[field.name])]),
    ),
  );
  const [secrets, setSecrets] = useState<Record<string, SecretValue>>(() =>
    Object.fromEntries(
      secretFields.map((field) => [field.name, initialSecret(initial.savedSecrets.includes(field.name))]),
    ),
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: ConnectionInput & { adapter?: string }) =>
      id === undefined
        ? api.post<ActionResult>("/connections", body)
        : api.put<ActionResult>(`/connections/${id}`, body),
    onSuccess: async (result) => {
      toast.success(result.message);
      await navigate({ to: `/admin/connections/${result.id ?? id}` });
      await refresh(client, CONNECTION_QUERY_KEYS);
    },
    onError: (error) => {
      const fields = serverFieldErrors(error);
      setErrors(fields);
      // A saved secret the server wants again (a changed URL): show its input.
      setSecrets((current) => {
        const next = { ...current };
        for (const field of secretFields) {
          if (fields[`secrets.${field.name}`] && next[field.name]?.mode !== "replace") {
            next[field.name] = { mode: "replace", value: "" };
          }
        }
        return next;
      });
      if (!(error instanceof ApiError && error.status === 422)) toast.error(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: ConnectionInput & { adapter?: string } = {
      ...(id === undefined ? { adapter: adapter.slug } : {}),
      name,
      enabled,
      ...(adapter.hasMode ? { mode } : {}),
      settings: Object.fromEntries(settingFields.map((field) => [field.name, settings[field.name]])),
      // Only secrets entered now; the server keeps the saved ones.
      secrets: Object.fromEntries(
        secretFields.flatMap((field) => {
          const value = secretPayload(secrets[field.name]!);
          return typeof value === "string" ? [[field.name, value]] : [];
        }),
      ),
    };
    const invalid = validate(connectionInputSchema, body);
    setErrors(invalid ?? {});
    if (!invalid) save.mutate(body);
  };

  const title = id === undefined ? `Add ${adapter.name}` : `Edit ${initial.name}`;
  return (
    <Page className="max-w-4xl">
      <PageHeader title={title} description={adapter.description} />
      <form onSubmit={submit} noValidate autoComplete="off" className="grid gap-4">
        <Card>
          <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <TextField
              id="name"
              label="Name"
              value={name}
              onChange={setName}
              error={errors.name}
              maxLength={100}
              required
            />
            {adapter.hasMode ? (
              <SelectField
                id="mode"
                label="Mode"
                value={mode}
                onChange={(value) => setMode(value as ConnectionMode)}
                options={MODES}
                error={errors.mode}
              />
            ) : null}
            <div className="sm:col-span-2">
              <SwitchField
                id="enabled"
                label="Enabled"
                hint={ENABLED_HELP}
                checked={enabled}
                onChange={setEnabled}
              />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Settings</h2>
            </CardTitle>
            <CardDescription>
              Secret values are stored encrypted and never shown again. See{" "}
              <a
                href={`${REPOSITORY_URL}/blob/main/docs/connections.md`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                docs/connections.md
              </a>{" "}
              for what each app needs.
            </CardDescription>
          </CardHeader>
          {adapter.fields.length > 0 ? (
            <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {adapter.fields.map((field) => (
                <div key={field.name} className={cn(field.kind === "textarea" && "sm:col-span-2")}>
                  {field.kind === "secret" ? (
                    <SecretField
                      id={`secret-${field.name}`}
                      label={labelOf(field)}
                      stored={initial.savedSecrets.includes(field.name)}
                      value={secrets[field.name]!}
                      onChange={(value) => setSecrets((current) => ({ ...current, [field.name]: value }))}
                      description={
                        [field.help, initial.savedSecrets.includes(field.name) ? KEEP_SECRET_HELP : ""]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      error={errors[`secrets.${field.name}`]}
                    />
                  ) : (
                    <SettingInput
                      field={field}
                      value={settings[field.name]!}
                      onChange={(value) => setSettings((current) => ({ ...current, [field.name]: value }))}
                      error={errors[`settings.${field.name}`]}
                    />
                  )}
                </div>
              ))}
            </CardContent>
          ) : null}
        </Card>
        <FormErrors messages={otherErrors(errors, /^(name|mode|enabled|settings\.|secrets\.)/)} />
        <FormActions
          pending={save.isPending}
          cancelTo={id === undefined ? "/admin/connections/new" : `/admin/connections/${id}`}
        />
      </form>
    </Page>
  );
}

/** The label of a setting; a required one ends in " *", as in the Django version. */
function labelOf(field: AdapterField): string {
  return field.required ? `${field.label} *` : field.label;
}

/** The input of one setting, by its kind. */
function SettingInput({
  field,
  value,
  onChange,
  error,
}: {
  field: AdapterField;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
  error?: string;
}) {
  const id = `setting-${field.name}`;
  const common = { id, label: labelOf(field), hint: field.help || undefined, error };
  switch (field.kind) {
    case "bool":
      return <CheckboxField {...common} checked={value === true} onChange={onChange} />;
    case "choice":
      return (
        <SelectField
          {...common}
          value={String(value)}
          onChange={onChange}
          options={field.choices.map(([choice, label]) => ({ value: choice, label }))}
        />
      );
    case "textarea":
      return (
        <TextareaField
          {...common}
          value={String(value)}
          onChange={onChange}
          rows={4}
          required={field.required}
        />
      );
    case "int":
      return (
        <TextField
          {...common}
          type="number"
          min={0}
          step={1}
          value={String(value)}
          onChange={onChange}
          required={field.required}
        />
      );
    default:
      return (
        <TextField
          {...common}
          type={field.kind === "url" ? "url" : field.kind === "email" ? "email" : "text"}
          placeholder={field.placeholder || undefined}
          value={String(value)}
          onChange={onChange}
          required={field.required}
          spellCheck={false}
        />
      );
  }
}
