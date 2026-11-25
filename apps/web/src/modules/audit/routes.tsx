import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { AuditPage } from "./audit-page";

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/audit",
  validateSearch: z.object({
    q: z.string().max(200).optional().catch(undefined),
    page: z.coerce.number().int().min(1).max(100_000).optional().catch(undefined),
  }),
  component: function AuditRoute() {
    const search = auditRoute.useSearch();
    const navigate = auditRoute.useNavigate();
    return <AuditPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

export const routes: AnyRoute[] = [auditRoute];
