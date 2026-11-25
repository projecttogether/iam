import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { PERSON_TYPE_LABELS, type PersonType } from "@iam/shared/labels";
import {
  personInputSchema,
  type ActionResult,
  type PersonDetail,
  type PersonInput,
  type PersonOptions,
} from "@iam/shared/api/iam";
import { api, ApiError } from "@/lib/api";
import { otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { FormErrors, SelectField, TextareaField, TextField } from "@/components/form-fields";
import { useRecordTitle } from "@/app/record-name";
import { personOptionsQuery, personQuery } from "./api";

/** The form's values, as text (IDs as strings, "" for none). */
export type PersonFormValues = {
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
  username: string;
  jobTitle: string;
  personType: PersonType;
  teamId: string;
  managerId: string;
  accessProfileId: string;
  startDate: string;
  endDate: string;
  notes: string;
};

const PERSON_TYPE_OPTIONS = Object.entries(PERSON_TYPE_LABELS).map(([value, label]) => ({ value, label }));

/** The fields the form shows; the server's messages for others show above the buttons. */
const SHOWN =
  /^(firstName|lastName|workEmail|personalEmail|username|jobTitle|personType|teamId|managerId|accessProfileId|startDate|endDate|notes)$/;

type Values = PersonFormValues;

function initialValues(person?: PersonDetail): Values {
  return {
    firstName: person?.firstName ?? "",
    lastName: person?.lastName ?? "",
    workEmail: person?.workEmail ?? "",
    personalEmail: person?.personalEmail ?? "",
    username: person?.username ?? "",
    jobTitle: person?.jobTitle ?? "",
    personType: person?.personType ?? "employee",
    teamId: person?.team ? String(person.team.id) : "",
    managerId: person?.manager ? String(person.manager.id) : "",
    accessProfileId: person?.accessProfile ? String(person.accessProfile.id) : "",
    startDate: person?.startDate ?? "",
    endDate: person?.endDate ?? "",
    notes: person?.notes ?? "",
  };
}

const idOrNull = (value: string) => (value ? Number(value) : null);

function toInput(values: Values): PersonInput {
  return {
    ...values,
    teamId: idOrNull(values.teamId),
    managerId: idOrNull(values.managerId),
    accessProfileId: idOrNull(values.accessProfileId),
    startDate: values.startDate || null,
    endDate: values.endDate || null,
  };
}

/** A label with Django's marker of a required field. */
function Required({ children }: { children: ReactNode }) {
  return (
    <>
      {children} <span aria-hidden="true">*</span>
    </>
  );
}

const toOptions = (refs: { id: number; name: string }[]) =>
  refs.map((ref) => ({ value: String(ref.id), label: ref.name }));

/**
 * Adds a person, or changes one (`person`). With `request`, adds the person
 * from an identity request, prefilled from it, and approves the request.
 * After saving, the person's page shows.
 */
export function PersonForm({
  person,
  options,
  request,
}: {
  person?: PersonDetail;
  options: PersonOptions;
  request?: { id: number; initial: Partial<Values> };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => ({ ...initialValues(person), ...request?.initial }));
  const [checked, setChecked] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (input: PersonInput) =>
      request
        ? api.post<ActionResult>(`/identity-requests/${request.id}/approve`, input)
        : person
          ? api.put<ActionResult>(`/people/${person.id}`, input)
          : api.post<ActionResult>("/people", input),
    onSuccess: async (result) => {
      toast.success(result.message);
      await Promise.all(
        [
          ["people"],
          ["person"],
          ["person-options"],
          ["dashboard"],
          ["audit"],
          ["identity-requests"],
          ["identity-request"],
          ["me"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      void navigate({ to: `/people/${result.id}` });
    },
  });
  const errors = { ...serverFieldErrors(save.error), ...checked };
  const formMessages = [
    ...(save.error && !(save.error instanceof ApiError && save.error.fields) ? [save.error.message] : []),
    ...otherErrors(errors, SHOWN),
  ];
  const change =
    <K extends keyof Values>(key: K) =>
    (value: Values[K]) => {
      setValues((current) => ({ ...current, [key]: value }));
    };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = toInput(values);
    const invalid = validate(personInputSchema, input);
    setChecked(invalid ?? {});
    if (invalid) return;
    save.mutate(input);
  };

  const defaultProfile = options.profiles.find((profile) => profile.defaultFor.includes(values.personType));
  const text = (key: Exclude<keyof Values, "personType">) => ({
    id: `person-${key}`,
    value: values[key],
    onChange: change(key),
    error: errors[key],
  });

  return (
    <form noValidate onSubmit={submit} className="grid gap-6">
      <Card>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <TextField
            {...text("firstName")}
            label={<Required>First name</Required>}
            required
            maxLength={150}
          />
          <TextField {...text("lastName")} label={<Required>Last name</Required>} required maxLength={150} />
          <TextField
            {...text("workEmail")}
            label="Work email"
            type="email"
            autoComplete="off"
            maxLength={254}
          />
          <TextField
            {...text("personalEmail")}
            label="Personal email"
            type="email"
            autoComplete="off"
            maxLength={254}
            hint="Receives the initial password of new accounts."
          />
          <TextField
            {...text("username")}
            label="Username"
            autoComplete="off"
            maxLength={150}
            hint="Login name in connected apps. Empty: the part of the work email before @."
          />
          <TextField {...text("jobTitle")} label="Job title" maxLength={200} />
          <SelectField
            id="person-personType"
            label={<Required>Person type</Required>}
            value={values.personType}
            onChange={(value) => change("personType")(value as PersonType)}
            options={PERSON_TYPE_OPTIONS}
            error={errors.personType}
            required
          />
          <SelectField {...text("teamId")} label="Team" options={toOptions(options.teams)} empty="None" />
          <SelectField
            {...text("managerId")}
            label="Manager"
            options={toOptions(options.managers)}
            empty="None"
          />
          <SelectField
            {...text("accessProfileId")}
            label="Access profile"
            options={toOptions(options.profiles)}
            empty={defaultProfile ? `Default for the type (${defaultProfile.name})` : "None"}
            hint="Empty: the profile that is the default for the person type."
          />
          <TextField {...text("startDate")} label="Start date" type="date" />
          <TextField {...text("endDate")} label="End date" type="date" hint="Last working day." />
          <div className="md:col-span-2">
            <TextareaField {...text("notes")} label="Notes" rows={3} />
          </div>
        </CardContent>
      </Card>
      <FormErrors messages={formMessages} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" asChild>
          <Link to={request ? `/requests/${request.id}` : person ? `/people/${person.id}` : "/people"}>
            Cancel
          </Link>
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner /> : null}
          {request ? "Add person and approve" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** /people/new */
export function NewPersonPage() {
  const options = useQuery(personOptionsQuery());
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title="Add person"
        description="Accounts follow the access profile and team. Onboarding starts automatically before the start date, or by hand."
      />
      {options.isPending ? (
        <LoadingState />
      ) : options.isError ? (
        <ErrorState error={options.error} onRetry={() => void options.refetch()} />
      ) : (
        <PersonForm options={options.data} />
      )}
    </Page>
  );
}

/** /people/$personId/edit */
export function EditPersonPage({ id }: { id: number }) {
  const person = useQuery(personQuery(id));
  const options = useQuery(personOptionsQuery(id));
  useRecordTitle(`/people/${id}`, person.data?.name);
  if (person.isPending || options.isPending) return <LoadingState />;
  if (person.isError) return <ErrorState error={person.error} onRetry={() => void person.refetch()} />;
  if (options.isError) return <ErrorState error={options.error} onRetry={() => void options.refetch()} />;
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={`Edit ${person.data.name}`}
        description="Accounts follow the access profile and team. Onboarding starts from the person page."
      />
      <PersonForm person={person.data} options={options.data} />
    </Page>
  );
}
