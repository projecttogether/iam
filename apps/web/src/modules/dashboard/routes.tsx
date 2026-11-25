import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute } from "@/routes/app";
import { DashboardPage } from "./dashboard-page";

const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardPage });

export const routes: AnyRoute[] = [dashboardRoute];
