import type { Person } from "../db/schema";

/** What a person's record says beyond its columns. */

export function fullName(person: Pick<Person, "firstName" | "lastName">): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/** Login name in connected apps: the username, or the part of the work email before @. */
export function loginName(person: Pick<Person, "username" | "workEmail">): string {
  if (person.username) return person.username;
  if (person.workEmail) return person.workEmail.split("@", 1)[0]!.toLowerCase();
  return "";
}

/** Whether the person's status allows access (desired access is empty otherwise). */
export function hasAccess(person: Pick<Person, "status">): boolean {
  return person.status === "onboarding" || person.status === "active";
}
