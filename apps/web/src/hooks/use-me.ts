import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Me } from "@iam/shared/api/iam";
import { api } from "@/lib/api";

export const meQuery = { queryKey: ["me"] as const, queryFn: () => api.get<Me>("/me"), staleTime: 30_000 };

/** The signed-in app user. Only use inside the signed-in app (its route loads it first). */
export function useMe(): Me {
  return useSuspenseQuery(meQuery).data;
}

/** The signed-in app user, or undefined while loading or signed out. */
export function useMaybeMe(): Me | undefined {
  return useQuery({ ...meQuery, retry: false }).data;
}

export function useIsAdmin(): boolean {
  return useMe().isAdmin;
}

export function useIsApprover(): boolean {
  return useMe().isApprover;
}
