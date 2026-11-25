import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { AboutCard, AppearanceCard, KeyboardShortcutsCard } from "@/components/ui/settings-cards";
import { useThemePreference } from "@/components/ui/theme";
import { OrganizationLogo } from "@/components/brand";
import { useMe } from "@/hooks/use-me";
import { useT } from "@/i18n";
import { commitUrl, REPOSITORY_URL } from "@/lib/repository";
import { messages } from "./messages";

/** The sign-in provider's account page (Keycloak's account console), where people manage their sign-in. */
function AccountCard({ url }: { url: string }) {
  const t = useT(messages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account")}</CardTitle>
        <CardDescription>{t("accountDescription")}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" size="sm" asChild>
          <a href={url}>{t("manageAccount")}</a>
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The person's own settings (Settings in the user menu): account, appearance, single-letter shortcuts (WCAG 2.1.4), about. */
export function PreferencesPage() {
  const t = useT(messages);
  const me = useMe();
  const [theme, setTheme] = useThemePreference();
  return (
    <Page className="max-w-3xl">
      <PageHeader title={t("title")} description={t("description")} />
      {me.accountUrl ? <AccountCard url={me.accountUrl} /> : null}
      <AppearanceCard value={theme} onChange={setTheme} />
      <KeyboardShortcutsCard />
      {/* The software and its version (the commit it was built from), also when an installation renames the app. */}
      <AboutCard
        logo={<OrganizationLogo className="size-10 rounded-md" />}
        text={t("about")}
        version={me.version || null}
        versionHref={me.version ? commitUrl(me.version) : undefined}
        repositoryUrl={REPOSITORY_URL}
      />
    </Page>
  );
}
