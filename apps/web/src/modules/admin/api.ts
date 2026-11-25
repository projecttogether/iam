import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  AdapterInfo,
  ApiKeyRow,
  ConnectionDetail,
  ConnectionForm,
  ConnectionRow,
  Ref,
  Settings,
  UserRow,
} from "@iam/shared/api/iam";
import type { AdapterKind } from "@iam/shared/labels";
import { api, errorMessage } from "@/lib/api";

export type ConnectionSection = { kind: AdapterKind; label: string; connections: ConnectionRow[] };
export type AdapterSection = { kind: AdapterKind; label: string; adapters: AdapterInfo[] };

export const connectionsQuery = {
  queryKey: ["connections"],
  queryFn: () => api.get<{ sections: ConnectionSection[]; hasConnections: boolean }>("/connections"),
};

export const connectionQuery = (id: number) => ({
  queryKey: ["connections", id],
  queryFn: () => api.get<ConnectionDetail>(`/connections/${id}`),
});

/** The values of the edit form: settings and the names of saved secrets, never their values. */
export const connectionFormQuery = (id: number) => ({
  queryKey: ["connections", id, "form"],
  queryFn: () => api.get<ConnectionForm>(`/connections/${id}/form`),
  // Always the saved state: a form opens with what the server has now.
  staleTime: 0,
  gcTime: 0,
});

export const adaptersQuery = {
  queryKey: ["adapters"],
  queryFn: () => api.get<AdapterSection[]>("/adapters"),
};

export const adapterQuery = (slug: string) => ({
  queryKey: ["adapters", slug],
  queryFn: () => api.get<AdapterInfo>(`/adapters/${encodeURIComponent(slug)}`),
});

export const usersQuery = { queryKey: ["users"], queryFn: () => api.get<UserRow[]>("/users") };

export const userQuery = (id: number) => ({
  queryKey: ["users", id],
  queryFn: () => api.get<UserRow>(`/users/${id}`),
});

/** The people an app user can be linked to. */
export const userOptionsQuery = {
  queryKey: ["user-options"],
  queryFn: () => api.get<{ people: Ref[] }>("/users/options"),
};

export const settingsQuery = { queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") };

export const apiKeysQuery = { queryKey: ["api-keys"], queryFn: () => api.get<ApiKeyRow[]>("/api-keys") };

/**
 * What a change to a connection may change elsewhere: its pages, the group
 * pickers of teams and profiles, the dashboard (errors, "nothing connected"),
 * people (accounts, imports), the audit log and the sidebar.
 */
export const CONNECTION_QUERY_KEYS: QueryKey[] = [
  ["connections"],
  ["group-connections"],
  ["profiles"],
  ["teams"],
  ["dashboard"],
  ["people"],
  ["person"],
  ["audit"],
  ["me"],
];

export function refresh(client: QueryClient, keys: QueryKey[]) {
  return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/** An action's answer: a test or a read answers `ok`, other actions only a message. */
type Answer = { ok?: boolean; message: string };

/**
 * The action buttons of a page: runs one request at a time, then refreshes
 * `keys` (and the sidebar) and toasts the answer, `ok: false` as an error.
 * `pending(name)` tells which button runs.
 */
export function useActions(keys: QueryKey[]) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ run }: { name: string; run: () => Promise<Answer> }) => run(),
    onSuccess: async (answer) => {
      if (answer.ok === false) toast.error(answer.message);
      else toast.success(answer.message);
      await refresh(client, [...keys, ["me"]]);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  return {
    run: (name: string, run: () => Promise<Answer>) =>
      mutation.mutateAsync({ name, run }).then(
        () => true,
        () => false,
      ),
    busy: mutation.isPending,
    pending: (name: string) => mutation.isPending && mutation.variables?.name === name,
  };
}
