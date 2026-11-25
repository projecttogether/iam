import { useEffect, useState } from "react";

/**
 * The name of the record a page shows, for the breadcrumbs. A page sets it
 * once it has loaded its record (`useRecordTitle`); the frame reads it for
 * the current path.
 */
let current: { path: string; name: string } | null = null;
const listeners = new Set<() => void>();

export function setRecordName(path: string, name: string) {
  current = { path, name };
  for (const listener of listeners) listener();
}

export function useRecordName(pathname: string): string | undefined {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  if (!current) return undefined;
  // The record's own page and the pages below it (edit).
  const base = current.path.replace(/\/+$/, "");
  return pathname === base || pathname.startsWith(`${base}/`) ? current.name : undefined;
}

/** Names the record of the page at `path` for the breadcrumbs, e.g. a person's name. */
export function useRecordTitle(path: string, name: string | undefined) {
  useEffect(() => {
    if (name) setRecordName(path, name);
  }, [path, name]);
}
