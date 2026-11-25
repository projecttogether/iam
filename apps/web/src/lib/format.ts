import { useMemo } from "react";
import { INTL_LOCALE, useLocale, type Locale } from "@/i18n";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Dates, times, numbers and sizes in US English. */
export function createFormatter(locale: Locale, now: () => number = Date.now) {
  const tag = INTL_LOCALE[locale];
  const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" });
  const dateOnly = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone: "UTC" });
  const number = new Intl.NumberFormat(tag);
  const decimal = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const relative = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  return {
    dateTime: (iso: string) => dateTime.format(new Date(iso)),
    number: (value: number) => number.format(value),
    /** A calendar date (YYYY-MM-DD), the same everywhere. */
    date: (value: string) => dateOnly.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)),
    /** Sizes in binary units: 812 B, 14 KB, 2.3 MB, 4.1 GB, 1.2 TB. */
    bytes: (value: number) => {
      if (value < 1024) return `${number.format(value)} B`;
      let size = value / 1024;
      let unit = 0;
      while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return `${unit === 0 ? number.format(Math.round(size)) : decimal.format(size)} ${SIZE_UNITS[unit]}`;
    },
    /** A duration: 42 s, 3 min 20 s, 1 h 5 min. */
    duration: (milliseconds: number) => {
      const seconds = Math.max(0, Math.round(milliseconds / 1000));
      if (seconds < 60) return `${seconds} s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
      const hours = Math.floor(minutes / 60);
      return minutes % 60 ? `${number.format(hours)} h ${minutes % 60} min` : `${number.format(hours)} h`;
    },
    /** "3 minutes ago", "yesterday", "in 2 hours". */
    relative: (iso: string) => {
      const seconds = Math.round((new Date(iso).getTime() - now()) / 1000);
      for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size || unit === "second") {
          return relative.format(Math.round(seconds / size), unit);
        }
      }
      return relative.format(0, "second");
    },
  };
}

export type Formatter = ReturnType<typeof createFormatter>;

export function useFormatter(): Formatter {
  const locale = useLocale();
  return useMemo(() => createFormatter(locale), [locale]);
}
