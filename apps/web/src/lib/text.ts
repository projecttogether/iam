import { CONNECTION_MODE_LABELS, type ConnectionMode } from "@iam/shared/labels";

/** Shortens a text to at most `max` characters, ending in "…" (Django's `truncatechars`). */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Shortens a text to at most `max` words, ending in "…" (Django's `truncatewords`). */
export function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length > max ? `${words.slice(0, max).join(" ")} …` : text;
}

/** The short name of a connection's mode: "Automatic", "Manual", "Read only". */
export function shortMode(mode: ConnectionMode): string {
  return CONNECTION_MODE_LABELS[mode].split(":")[0]!;
}
