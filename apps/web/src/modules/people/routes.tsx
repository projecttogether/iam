import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERSON_STATUS_LABELS, type PersonStatus } from "@iam/shared/labels";
import { appRoute, requireRole } from "@/routes/app";
import { PeoplePage } from "./people-page";
import { PersonPage } from "./person-page";
import { EditPersonPage, NewPersonPage } from "./person-form";

const STATUSES = Object.keys(PERSON_STATUS_LABELS) as [PersonStatus, ...PersonStatus[]];
const pageParam = z.coerce.number().int().min(1).max(100_000).optional().catch(undefined);

const peopleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/people",
  validateSearch: z.object({
    q: z.string().max(200).optional().catch(undefined),
    status: z.enum(STATUSES).optional().catch(undefined),
    team: z.coerce.number().int().positive().optional().catch(undefined),
    page: pageParam,
  }),
  component: function PeopleRoute() {
    const search = peopleRoute.useSearch();
    const navigate = peopleRoute.useNavigate();
    return <PeoplePage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

const newPersonRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/people/new",
  beforeLoad: requireRole("approver"),
  component: NewPersonPage,
});

const personRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/people/$personId",
  component: function PersonRoute() {
    const { personId } = personRoute.useParams();
    return <PersonPage key={personId} id={Number(personId)} />;
  },
});

const editPersonRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/people/$personId/edit",
  beforeLoad: requireRole("approver"),
  component: function EditPersonRoute() {
    const { personId } = editPersonRoute.useParams();
    return <EditPersonPage key={personId} id={Number(personId)} />;
  },
});

export const routes: AnyRoute[] = [peopleRoute, newPersonRoute, personRoute, editPersonRoute];
