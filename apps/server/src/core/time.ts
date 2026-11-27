import { config } from "../config";

/**
 * Dates. Start dates, end dates and the schedule follow the time zone of
 * TZ; dates travel as YYYY-MM-DD strings.
 */

/** Tests only: replaces the clock of `now()` and `today()`. */
export const clock = { now: () => new Date() };

export function now(): Date {
  return clock.now();
}

/** The calendar date of `instant` in the app's time zone, as YYYY-MM-DD. */
export function localDate(instant: Date = now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Today in the app's time zone, as YYYY-MM-DD. */
export function today(): string {
  return localDate(now());
}

/** A YYYY-MM-DD date moved by `days`. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** DD.MM.YYYY, as the app writes dates in texts. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

/** Whether a string is a real calendar date as YYYY-MM-DD. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A Date `ms` milliseconds after `from`. */
export function after(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}
