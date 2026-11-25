import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { IDENTITY_REQUEST_STATUS_LABELS, type IdentityRequestStatus } from "@iam/shared/labels";
import { appRoute, requireRole } from "@/routes/app";
import { RequestsPage } from "./requests-page";
import { RequestPage } from "./request-page";
import { ApproveRequestPage } from "./approve-page";

const STATUSES: [IdentityRequestStatus | "all", ...(IdentityRequestStatus | "all")[]] = [
  "all",
  ...(Object.keys(IDENTITY_REQUEST_STATUS_LABELS) as IdentityRequestStatus[]),
];

const requestsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/requests",
  validateSearch: z.object({
    status: z.enum(STATUSES).optional().catch(undefined),
    page: z.coerce.number().int().min(1).max(100_000).optional().catch(undefined),
  }),
  component: function RequestsRoute() {
    const search = requestsRoute.useSearch();
    const navigate = requestsRoute.useNavigate();
    return <RequestsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

const requestRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/requests/$requestId",
  component: function RequestRoute() {
    const { requestId } = requestRoute.useParams();
    return <RequestPage key={requestId} id={Number(requestId)} />;
  },
});

const approveRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/requests/$requestId/approve",
  beforeLoad: requireRole("approver"),
  component: function ApproveRoute() {
    const { requestId } = approveRoute.useParams();
    return <ApproveRequestPage key={requestId} id={Number(requestId)} />;
  },
});

/** Identity requests from other apps. */
export const routes: AnyRoute[] = [requestsRoute, requestRoute, approveRoute];
