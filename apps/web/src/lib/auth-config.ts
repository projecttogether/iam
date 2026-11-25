import { useQuery } from "@tanstack/react-query";
import type { AuthConfig } from "@iam/shared/api/iam";
import { api } from "./api";

export const DEFAULT_APP_NAME = "IAM";

export const authConfigQuery = {
  queryKey: ["auth-config"] as const,
  queryFn: () => api.get<AuthConfig>("/auth-config"),
  staleTime: 5 * 60_000,
};

/** The app name and sign-in provider (public). */
export function useAuthConfig() {
  return useQuery(authConfigQuery).data;
}
