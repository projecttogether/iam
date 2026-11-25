import { createRoute, useParams, type AnyRoute } from "@tanstack/react-router";
import { appRoute, requireRole } from "@/routes/app";
import { TeamsPage } from "./teams-page";
import { TeamPage } from "./team-page";
import { TeamFormPage } from "./team-form-page";
import { ProfilesPage } from "./profiles-page";
import { ProfilePage } from "./profile-page";
import { ProfileFormPage } from "./profile-form-page";

/** A numeric route parameter of the current page. */
function useId(name: "teamId" | "profileId"): number {
  const params: Record<string, string | undefined> = useParams({ strict: false });
  return Number(params[name]);
}

const teamsRoute = createRoute({ getParentRoute: () => appRoute, path: "/teams", component: TeamsPage });
const teamNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/teams/new",
  beforeLoad: requireRole("admin"),
  component: () => <TeamFormPage />,
});
const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/teams/$teamId",
  component: function TeamRoute() {
    const id = useId("teamId");
    return <TeamPage key={id} id={id} />;
  },
});
const teamEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/teams/$teamId/edit",
  beforeLoad: requireRole("admin"),
  component: function TeamEditRoute() {
    const id = useId("teamId");
    return <TeamFormPage key={id} id={id} />;
  },
});

const profilesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profiles",
  component: ProfilesPage,
});
const profileNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profiles/new",
  beforeLoad: requireRole("admin"),
  component: () => <ProfileFormPage />,
});
const profileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profiles/$profileId",
  component: function ProfileRoute() {
    const id = useId("profileId");
    return <ProfilePage key={id} id={id} />;
  },
});
const profileEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profiles/$profileId/edit",
  beforeLoad: requireRole("admin"),
  component: function ProfileEditRoute() {
    const id = useId("profileId");
    return <ProfileFormPage key={id} id={id} />;
  },
});

/** Teams and access profiles: everyone reads them, admins change them. */
export const routes: AnyRoute[] = [
  teamsRoute,
  teamNewRoute,
  teamRoute,
  teamEditRoute,
  profilesRoute,
  profileNewRoute,
  profileRoute,
  profileEditRoute,
];
