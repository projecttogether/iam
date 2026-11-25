import { keepPreviousData } from "@tanstack/react-query";
import type { Paged, PersonDetail, PersonOptions, PersonRow } from "@iam/shared/api/iam";
import type { PersonStatus } from "@iam/shared/labels";
import { api } from "@/lib/api";

/** The filters of the people list, as in the address (`?q=&status=&team=&page=`). */
export type PeopleSearch = { q?: string; status?: PersonStatus; team?: number; page?: number };

export const peopleQuery = (search: PeopleSearch) => ({
  queryKey: ["people", search],
  queryFn: () => api.get<Paged<PersonRow>>("/people", search),
  placeholderData: keepPreviousData,
});

export const personQuery = (id: number) => ({
  queryKey: ["person", id],
  queryFn: () => api.get<PersonDetail>(`/people/${id}`),
});

/** Teams, access profiles and managers (everyone not archived but `personId`). */
export const personOptionsQuery = (personId?: number) => ({
  queryKey: ["person-options", personId ?? 0],
  queryFn: () => api.get<PersonOptions>("/people/options", { person: personId }),
});
