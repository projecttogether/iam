import type { Me, PersonDetail, PersonOptions } from "@iam/shared/api/iam";

/** Answers of the API for the tests of the people pages. */

export function me(role: Me["role"]): Me {
  return {
    id: 1,
    email: `${role}@example.invalid`,
    name: role,
    role,
    isAdmin: role === "admin",
    isApprover: role !== "viewer",
    organizationName: "Example",
    accountUrl: "",
    readOnly: false,
    version: "0.0.0",
    counts: { openTasks: 0, failedJobs: 0, heldJobs: 0, openRequests: 0 },
  };
}

export function personDetail(overrides: Partial<PersonDetail> = {}): PersonDetail {
  return {
    id: 7,
    firstName: "Ada",
    lastName: "Lovelace",
    name: "Ada Lovelace",
    workEmail: "ada@example.invalid",
    personalEmail: "",
    username: "",
    loginName: "ada",
    jobTitle: "Engineer",
    personType: "employee",
    status: "planned",
    team: { id: 3, name: "Engineering" },
    manager: null,
    accessProfile: { id: 2, name: "Staff" },
    startDate: "2026-12-01",
    endDate: null,
    contractEndDate: null,
    terminationDate: null,
    lastDayAtWork: null,
    source: null,
    notes: "",
    onboardingPaused: false,
    today: "2026-11-20",
    accessRows: [
      {
        connection: { id: 5, name: "Keycloak" },
        grant: { groups: [{ label: "/staff", reasons: ["profile Staff"] }] },
        account: null,
      },
    ],
    workflows: [],
    openJobs: [],
    tasks: [],
    events: [],
    can: { onboard: true, update: false, offboard: true, archive: true },
    ...overrides,
  };
}

export const personOptions: PersonOptions = {
  teams: [{ id: 3, name: "Engineering" }],
  profiles: [{ id: 2, name: "Staff", defaultFor: ["employee"] }],
  managers: [{ id: 9, name: "Grace Hopper" }],
};
