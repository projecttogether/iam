import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { settingsInputSchema, type Settings, type SettingsInput } from "@iam/shared/api/iam";
import { PERSON_TYPE_LABELS, type PersonType } from "@iam/shared/labels";
import { api, ApiError, errorMessage } from "@/lib/api";
import { otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { CheckboxField, FormErrors, TextareaField, TextField } from "@/components/form-fields";
import { refresh, settingsQuery } from "./api";

/** Admin › Settings: lifecycle rules, notifications and identity requests. */
export function SettingsPage() {
  const query = useQuery(settingsQuery);
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title="Settings"
        description="Lifecycle rules, notifications and identity requests. Sign-in and deployment settings are environment variables (docs/configuration.md)."
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <SettingsForm settings={query.data} />
      )}
    </Page>
  );
}

/**
 * A whole number as Django's IntegerField reads it: an optional sign, digits
 * and an optional ".0…" ("7", "+7", "7.00"); anything else ("1e2", "7.5") is
 * a message.
 */
function wholeNumber(text: string): { value: number } | { error: string } {
  if (text.trim() === "") return { error: "This field is required." };
  const match = /^\s*([+-]?\d+)(?:\.0*)?\s*$/.exec(text);
  return match ? { value: Number(match[1]) } : { error: "Enter a whole number." };
}

function SettingsForm({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const [organizationName, setOrganizationName] = useState(settings.organizationName);
  const [automaticOnboarding, setAutomaticOnboarding] = useState(settings.automaticOnboarding);
  const [onboardingLeadDays, setOnboardingLeadDays] = useState(String(settings.onboardingLeadDays));
  const [automaticOffboarding, setAutomaticOffboarding] = useState(settings.automaticOffboarding);
  const [removalLimitPerDay, setRemovalLimitPerDay] = useState(String(settings.removalLimitPerDay));
  const [notificationEmails, setNotificationEmails] = useState(settings.notificationEmails);
  const [identityRequestTypes, setIdentityRequestTypes] = useState<PersonType[]>(
    settings.identityRequestTypes,
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (input: SettingsInput) => api.put<Settings & { message: string }>("/settings", input),
    onSuccess: async (result) => {
      toast.success(result.message);
      client.setQueryData(settingsQuery.queryKey, result);
      // The organization name is the app's name in the frame.
      await refresh(client, [["settings"], ["audit"], ["me"]]);
    },
    onError: (error) => {
      setErrors(serverFieldErrors(error));
      if (!(error instanceof ApiError && error.status === 422)) toast.error(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const leadDays = wholeNumber(onboardingLeadDays);
    const removalLimit = wholeNumber(removalLimitPerDay);
    const input: SettingsInput = {
      organizationName,
      automaticOnboarding,
      onboardingLeadDays: "value" in leadDays ? leadDays.value : 0,
      automaticOffboarding,
      removalLimitPerDay: "value" in removalLimit ? removalLimit.value : 0,
      notificationEmails,
      identityRequestTypes,
    };
    const invalid: FieldErrors = { ...validate(settingsInputSchema, input) };
    if ("error" in leadDays) invalid.onboardingLeadDays = leadDays.error;
    if ("error" in removalLimit) invalid.removalLimitPerDay = removalLimit.error;
    setErrors(invalid);
    if (Object.keys(invalid).length === 0) save.mutate(input);
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <Card>
        <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2 sm:max-w-[calc(50%-0.625rem)]">
            <TextField
              id="organization-name"
              label="Organization name"
              value={organizationName}
              onChange={setOrganizationName}
              error={errors.organizationName}
              maxLength={200}
              required
            />
          </div>
          <CheckboxField
            id="automatic-onboarding"
            label="Automatic onboarding"
            hint="Start onboarding for planned people when their start date nears."
            checked={automaticOnboarding}
            onChange={setAutomaticOnboarding}
            error={errors.automaticOnboarding}
          />
          <TextField
            id="onboarding-lead-days"
            label="Onboarding lead days"
            type="number"
            min={0}
            step={1}
            hint="Days before the start date when onboarding starts automatically."
            value={onboardingLeadDays}
            onChange={setOnboardingLeadDays}
            error={errors.onboardingLeadDays}
            required
          />
          <CheckboxField
            id="automatic-offboarding"
            label="Automatic offboarding"
            hint="Start offboarding the day after a person's end date."
            checked={automaticOffboarding}
            onChange={setAutomaticOffboarding}
            error={errors.automaticOffboarding}
          />
          <TextField
            id="removal-limit-per-day"
            label="Removal limit per day"
            type="number"
            min={0}
            step={1}
            hint="Automatic account removals per connection and 24 hours. Removals beyond the limit wait for an admin's approval. 0 holds every automatic removal."
            value={removalLimitPerDay}
            onChange={setRemovalLimitPerDay}
            error={errors.removalLimitPerDay}
            required
          />
          <div className="sm:col-span-2">
            <TextareaField
              id="notification-emails"
              label="Notification emails"
              hint="Addresses that get an email for new manual tasks and identity requests, one per line."
              value={notificationEmails}
              onChange={setNotificationEmails}
              error={errors.notificationEmails}
              rows={3}
            />
          </div>
          <fieldset className="grid gap-3 sm:col-span-2" aria-describedby="identity-request-types-hint">
            <legend className="mb-1 text-sm font-medium">Identity requests</legend>
            <p id="identity-request-types-hint" className="text-muted-foreground text-sm">
              The person types other apps, such as Helpdesk, may request with an API key (Admin › API keys).
              None: the app accepts no requests.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {(Object.entries(PERSON_TYPE_LABELS) as [PersonType, string][]).map(([type, label]) => (
                <CheckboxField
                  key={type}
                  id={`identity-request-type-${type}`}
                  label={label}
                  checked={identityRequestTypes.includes(type)}
                  onChange={(checked) =>
                    setIdentityRequestTypes((current) =>
                      checked ? [...current, type] : current.filter((value) => value !== type),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
        </CardContent>
      </Card>
      <FormErrors
        messages={otherErrors(
          errors,
          /^(organizationName|automaticOnboarding|onboardingLeadDays|automaticOffboarding|removalLimitPerDay|notificationEmails)$/,
        )}
      />
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}
