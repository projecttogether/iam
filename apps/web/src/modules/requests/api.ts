import { keepPreviousData } from "@tanstack/react-query";
import type { IdentityRequestDetail, IdentityRequestRow, Paged } from "@iam/shared/api/iam";
import type { IdentityRequestStatus } from "@iam/shared/labels";
import { api } from "@/lib/api";

/** The filter of the request list, as in the address (`?status=&page=`); no status: open. */
export type RequestsSearch = { status?: IdentityRequestStatus | "all"; page?: number };

export const requestsQuery = (search: RequestsSearch) => ({
  queryKey: ["identity-requests", search],
  queryFn: () => api.get<Paged<IdentityRequestRow>>("/identity-requests", search),
  placeholderData: keepPreviousData,
});

export const requestQuery = (id: number) => ({
  queryKey: ["identity-request", id],
  queryFn: () => api.get<IdentityRequestDetail>(`/identity-requests/${id}`),
});
