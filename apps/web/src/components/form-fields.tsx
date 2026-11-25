import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/** The ids of a field's hint and error, for aria-describedby. */
export function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

/** A labelled text input with its hint and error. A password stays hidden until its eye button shows it. */
export function TextField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  type,
  ...input
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<ComponentProps<"input">, "id" | "value" | "onChange">) {
  const control = {
    id,
    value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, hint, error),
    ...input,
  };
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {type === "password" ? <SecretInput {...control} /> : <Input type={type} {...control} />}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A labelled choice (a native select) with its hint and error. `value` "" is the empty option, if `empty` names it. */
export function SelectField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  options,
  empty,
  required,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  /** The label of the empty option; without it, there is none. */
  empty?: string;
  required?: boolean;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        wrapperClassName="w-full"
        className="w-full"
      >
        {empty !== undefined ? <NativeSelectOption value="">{empty}</NativeSelectOption> : null}
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A labelled multi-line text with its hint and error. */
export function TextareaField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  ...textarea
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<ComponentProps<"textarea">, "id" | "value" | "onChange">) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...textarea}
      />
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A switch with its label and hint beside it. */
export function SwitchField(props: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Switch
        id={props.id}
        checked={props.checked}
        onCheckedChange={props.onChange}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      />
      <FieldContent>
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
        {props.hint ? <FieldDescription id={`${props.id}-hint`}>{props.hint}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

/** A checkbox with its label and hint beside it, for a yes/no value of a form. */
export function CheckboxField(props: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Field orientation="horizontal" data-invalid={props.error ? true : undefined}>
      <Checkbox
        id={props.id}
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(checked === true)}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, props.error)}
      />
      <FieldContent>
        <FieldLabel htmlFor={props.id} className="font-normal">
          {props.label}
        </FieldLabel>
        {props.hint ? <FieldDescription id={`${props.id}-hint`}>{props.hint}</FieldDescription> : null}
        {props.error ? <FieldError id={`${props.id}-error`}>{props.error}</FieldError> : null}
      </FieldContent>
    </Field>
  );
}

/** The buttons under a form: Save (busy while `pending`) and Cancel, a link back to `cancelTo`. */
export function FormActions({
  pending,
  cancelTo,
  saveLabel = "Save",
}: {
  pending: boolean;
  cancelTo: string;
  saveLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={pending}>
        {pending ? <Spinner /> : null}
        {saveLabel}
      </Button>
      <Button asChild variant="outline">
        <Link to={cancelTo}>Cancel</Link>
      </Button>
    </div>
  );
}

/** Errors that belong to no field of the form. */
export function FormErrors({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="list-disc pl-4">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
