import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ActionResult } from "@iam/shared/api/iam";
import { api, errorMessage } from "@/lib/api";

/**
 * The queries an action on a person, workflow, job, task or identity request may change: they
 * all show the same work. `["me"]` holds the counts of the sidebar badges.
 */
export const WORK_QUERY_KEYS: QueryKey[] = [
  ["people"],
  ["person"],
  ["workflows"],
  ["workflow"],
  ["jobs"],
  ["job"],
  ["tasks"],
  ["task"],
  ["dashboard"],
  ["audit"],
  ["identity-requests"],
  ["identity-request"],
  ["me"],
];

/**
 * A button's action: posts to `path`, then refreshes the work queries and
 * toasts the answer's message. An error (e.g. a 409 because the state
 * changed meanwhile) shows its message as an error toast.
 */
export function useAction(options: { onDone?: (result: ActionResult) => void } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<ActionResult>(path, body),
    onSuccess: async (result) => {
      toast.success(result.message);
      options.onDone?.(result);
      await Promise.all(WORK_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
}
