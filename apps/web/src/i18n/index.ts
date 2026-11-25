import { createContext, useCallback, useContext } from "react";

/**
 * Texts. The app is in English (US). Each module keeps its own catalog next
 * to its code:
 *
 *   export const messages = defineMessages({
 *     en: { title: "Contacts", count: "{count} contacts" },
 *   });
 *   const t = useT(messages);  t("count", { count: 3 })
 *
 * Only English for now; a catalog may add another language later
 * (`de`, with every English key, checked by TypeScript).
 *
 * Singular: when `count` is 1, a key `<key>_one` wins if the catalog has one:
 *
 *     { members: "{count} members", members_one: "1 member" }
 */
export type Locale = "en" | "de";
export type Catalog = Record<string, string>;
export type Messages<T extends Catalog> = { en: T; de?: { [K in keyof T]: string } };

/** The language tag for dates and numbers. */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-US", de: "de-DE" };

export function defineMessages<T extends Catalog>(messages: Messages<T>): Messages<T> {
  return messages;
}

export const LocaleContext = createContext<Locale>("en");

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export function translate<T extends Catalog>(messages: Messages<T>, locale: Locale) {
  const english = messages.en as Catalog;
  const catalog = (messages[locale] as Catalog | undefined) ?? english;
  return (key: keyof T & string, params?: Record<string, string | number>) => {
    const one = params !== undefined && Number(params.count) === 1 ? `${key}_one` : null;
    const template =
      (one ? (catalog[one] ?? english[one]) : undefined) ?? catalog[key] ?? english[key] ?? key;
    return interpolate(template, params);
  };
}

/** The translate function for a module's catalog in the current language. */
export function useT<T extends Catalog>(messages: Messages<T>) {
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(translate(messages, locale), [messages, locale]);
}
