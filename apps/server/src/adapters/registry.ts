import type { AdapterClass } from "./base";
import { GoogleWorkspaceAdapter } from "./google-workspace";
import { HubSpotAdapter } from "./hubspot";
import { KeycloakAdapter } from "./keycloak";
import { ManualAdapter } from "./manual";
import { NotionAdapter } from "./notion";
import { PersonioAdapter } from "./personio";
import { RelutionAdapter } from "./relution";
import { ScimAdapter } from "./scim";
import { SlackAdapter } from "./slack";
import { SmtpAdapter } from "./smtp";

/** The adapters admins can connect in Admin › Connections, in the order the admin section lists them. */
const ADAPTERS = new Map<string, AdapterClass>(
  [
    KeycloakAdapter,
    GoogleWorkspaceAdapter,
    ScimAdapter,
    HubSpotAdapter,
    SlackAdapter,
    NotionAdapter,
    RelutionAdapter,
    ManualAdapter,
    PersonioAdapter,
    SmtpAdapter,
  ].map((cls) => [cls.slug, cls as AdapterClass]),
);

export function getAdapterClass(slug: string): AdapterClass | null {
  return ADAPTERS.get(slug) ?? null;
}

export function adapterClasses(): AdapterClass[] {
  return [...ADAPTERS.values()];
}

/** Tests only: register an adapter (e.g. the fake one); returns a function that removes it. */
export function registerAdapterForTests(cls: AdapterClass): () => void {
  ADAPTERS.set(cls.slug, cls);
  return () => ADAPTERS.delete(cls.slug);
}
