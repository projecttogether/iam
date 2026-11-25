import type { AnyRoute } from "@tanstack/react-router";
import { routes as admin } from "./admin/routes";
import { routes as audit } from "./audit/routes";
import { routes as dashboard } from "./dashboard/routes";
import { routes as people } from "./people/routes";
import { routes as policy } from "./policy/routes";
import { routes as preferences } from "./preferences/routes";
import { routes as requests } from "./requests/routes";
import { routes as work } from "./work/routes";

/** Routes of every module inside the signed-in app. Add new modules here. */
export const appRoutes: AnyRoute[] = [
  ...dashboard,
  ...people,
  ...requests,
  ...work,
  ...policy,
  ...audit,
  ...admin,
  ...preferences,
];
