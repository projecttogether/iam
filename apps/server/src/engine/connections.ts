import { config } from "../config";
import { decrypt, encrypt } from "../core/crypto";
import {
  AdapterKind,
  readOnly,
  type Adapter,
  type AdapterClass,
  type AdapterOptions,
} from "../adapters/base";
import { getAdapterClass } from "../adapters/registry";
import type { Connection } from "../db/schema";

/** What the app knows about a connection from its adapter and settings. */

export function adapterClassOf(connection: Pick<Connection, "adapter">): AdapterClass | null {
  return getAdapterClass(connection.adapter);
}

/** The connection's kind; empty for an adapter this version does not know. */
export function kindOf(connection: Pick<Connection, "adapter">): AdapterKind | "" {
  return adapterClassOf(connection)?.kind ?? "";
}

/** The decrypted secrets. Throws SecretUnreadable when no configured key reads them. */
export function secretsOf(connection: Pick<Connection, "secretData">): Record<string, string> {
  if (!connection.secretData) return {};
  return JSON.parse(decrypt(connection.secretData)) as Record<string, string>;
}

/** The encrypted form of secrets; empty for none. */
export function encryptSecrets(values: Record<string, string>): string {
  return Object.keys(values).length > 0 ? encrypt(JSON.stringify(values)) : "";
}

export function configOf(connection: Pick<Connection, "settings" | "secretData">): Record<string, unknown> {
  return { ...connection.settings, ...secretsOf(connection) };
}

/** The adapter for this connection. In read-only mode it can only read. */
export function buildAdapter(
  connection: Connection,
  options: Omit<AdapterOptions, "connectionId"> = {},
): Adapter {
  const cls = adapterClassOf(connection);
  if (cls === null) throw new Error(`Unknown adapter ${JSON.stringify(connection.adapter)}`);
  const adapter = new cls(configOf(connection), { ...options, connectionId: connection.id });
  return config().READ_ONLY ? readOnly(adapter) : adapter;
}

export function supportsGroups(connection: Connection): boolean {
  const cls = adapterClassOf(connection);
  return Boolean(cls && cls.groupsEnabled(connection.settings));
}

export function canImportGroups(connection: Connection): boolean {
  const cls = adapterClassOf(connection);
  return Boolean(cls && cls.importsGroups() && supportsGroups(connection));
}

/** Whether the app makes changes at this connection itself. */
export function writesAutomatically(connection: Connection): boolean {
  const cls = adapterClassOf(connection);
  return Boolean(connection.enabled && connection.mode === "automatic" && cls !== null && cls.supportsWrite);
}

export function syncIntervalMinutes(connection: Connection): number {
  const value = connection.settings.sync_interval_minutes;
  let minutes = 0;
  if (typeof value === "number" && Number.isFinite(value)) minutes = Math.trunc(value);
  else if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) minutes = Number.parseInt(value, 10);
  return Math.max(minutes, 0);
}

export function isProvisioning(connection: Pick<Connection, "adapter">): boolean {
  return kindOf(connection) === AdapterKind.PROVISIONING;
}
