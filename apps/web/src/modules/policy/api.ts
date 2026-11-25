import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { GroupConnection, ProfileDetail, ProfileRow, TeamDetail, TeamRow } from "@iam/shared/api/iam";
import { api } from "@/lib/api";

export const teamsQuery = { queryKey: ["teams"], queryFn: () => api.get<TeamRow[]>("/teams") };

export const teamQuery = (id: number) => ({
  queryKey: ["teams", id],
  queryFn: () => api.get<TeamDetail>(`/teams/${id}`),
});

export const profilesQuery = { queryKey: ["profiles"], queryFn: () => api.get<ProfileRow[]>("/profiles") };

export const profileQuery = (id: number) => ({
  queryKey: ["profiles", id],
  queryFn: () => api.get<ProfileDetail>(`/profiles/${id}`),
});

/** Account connections with the groups a team or profile can choose. */
export const groupConnectionsQuery = {
  queryKey: ["group-connections"],
  queryFn: () => api.get<GroupConnection[]>("/group-connections"),
};

/**
 * What a saved or deleted team or profile changes elsewhere: the lists, the
 * people pages that name them, the options of the person form, the audit
 * log, the connection pages ("Used by") and the sidebar.
 */
const POLICY_QUERY_KEYS: QueryKey[] = [
  ["teams"],
  ["profiles"],
  ["people"],
  ["person"],
  ["person-options"],
  ["connections"],
  ["audit"],
  ["me"],
];

export function refreshPolicy(client: QueryClient) {
  return Promise.all(POLICY_QUERY_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}
