import { createRoute, useParams, type AnyRoute } from "@tanstack/react-router";
import { appRoute, requireRole } from "@/routes/app";
import { ConnectionsPage } from "./connections-page";
import { ChooseAdapterPage } from "./choose-adapter-page";
import { ConnectionFormPage } from "./connection-form-page";
import { ConnectionPage } from "./connection-page";
import { UsersPage } from "./users-page";
import { UserFormPage } from "./user-form-page";
import { SettingsPage } from "./settings-page";
import { ApiKeysPage } from "./api-keys-page";

/** A route parameter of the current page. */
function useParam(name: "connectionId" | "userId" | "adapter"): string {
  const params: Record<string, string | undefined> = useParams({ strict: false });
  return params[name] ?? "";
}

const admin = { getParentRoute: () => appRoute, beforeLoad: requireRole("admin") } as const;

const connectionsRoute = createRoute({ ...admin, path: "/admin/connections", component: ConnectionsPage });
const chooseAdapterRoute = createRoute({
  ...admin,
  path: "/admin/connections/new",
  component: ChooseAdapterPage,
});
const connectionNewRoute = createRoute({
  ...admin,
  path: "/admin/connections/new/$adapter",
  component: function ConnectionNewRoute() {
    const adapter = useParam("adapter");
    return <ConnectionFormPage key={adapter} adapter={adapter} />;
  },
});
const connectionRoute = createRoute({
  ...admin,
  path: "/admin/connections/$connectionId",
  component: function ConnectionRoute() {
    const id = Number(useParam("connectionId"));
    return <ConnectionPage key={id} id={id} />;
  },
});
const connectionEditRoute = createRoute({
  ...admin,
  path: "/admin/connections/$connectionId/edit",
  component: function ConnectionEditRoute() {
    const id = Number(useParam("connectionId"));
    return <ConnectionFormPage key={id} id={id} />;
  },
});

const usersRoute = createRoute({ ...admin, path: "/admin/users", component: UsersPage });
const userNewRoute = createRoute({ ...admin, path: "/admin/users/new", component: () => <UserFormPage /> });
const userRoute = createRoute({
  ...admin,
  path: "/admin/users/$userId",
  component: function UserRoute() {
    const id = Number(useParam("userId"));
    return <UserFormPage key={id} id={id} />;
  },
});

const settingsRoute = createRoute({ ...admin, path: "/admin/settings", component: SettingsPage });
const apiKeysRoute = createRoute({ ...admin, path: "/admin/api-keys", component: ApiKeysPage });

/** Admin: connections, users and roles, API keys, settings (admins only; the server checks too). */
export const routes: AnyRoute[] = [
  connectionsRoute,
  chooseAdapterRoute,
  connectionNewRoute,
  connectionRoute,
  connectionEditRoute,
  usersRoute,
  userNewRoute,
  userRoute,
  apiKeysRoute,
  settingsRoute,
];
