import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ActionResult } from "@iam/shared/api/iam";
import { api, errorMessage } from "@/lib/api";

/**
 * A Delete button that asks first, then sends DELETE `path`, toasts the
 * answer's message and calls `onDeleted` (e.g. to open the list). An error,
 * such as a 409 because the record is still in use, shows its message; the
 * dialog stays open.
 */
export function DeleteButton(props: {
  path: string;
  title: ReactNode;
  description?: ReactNode;
  /** Default: "Delete". */
  label?: string;
  onDeleted: (result: ActionResult) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const label = props.label ?? "Delete";
  const confirm = async () => {
    let result: ActionResult;
    try {
      result = await api.delete<ActionResult>(props.path);
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
    toast.success(result.message);
    await props.onDeleted(result);
  };
  return (
    <>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={props.title}
        description={props.description}
        confirmLabel={label}
        destructive
        onConfirm={confirm}
      />
    </>
  );
}
