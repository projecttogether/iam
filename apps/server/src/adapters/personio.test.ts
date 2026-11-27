import { describe, expect, it } from "vitest";
import { addDays, today } from "../core/time";
import { AdapterError, ConfigurationError, TransientError } from "./base";
import { isEmail } from "@iam/shared/email";
import { PersonioAdapter, parseDate } from "./personio";
import { answer, json, mockFetch, type Handler, type SeenRequest } from "../test/mock-fetch";

const CONFIG = { client_id: "client", client_secret: "s3cret-value" };

type Json = Record<string, unknown>;

function attr(value: unknown, label?: string): Json {
  const data: Json = { value };
  if (label) data.label = label;
  return data;
}

function employee(
  pid: string,
  first: string,
  last: string,
  attributes: Json = {},
): { type: string; attributes: Json } {
  return {
    type: "Employee",
    attributes: {
      id: attr(pid),
      first_name: attr(first, "First name"),
      last_name: attr(last, "Last name"),
      ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, attr(value)])),
    },
  };
}

/** A fake Personio API: auth, attribute catalog, employee pages by offset. */
function personio(pages: unknown[][], attributes: unknown[] = [], authStatus = 200): Handler {
  return (request: SeenRequest) => {
    if (request.url.pathname === "/v1/auth") {
      if (authStatus !== 200) return json(authStatus, { success: false });
      expect.soft(request.json()).toEqual({ client_id: "client", client_secret: "s3cret-value" });
      return json(200, { success: true, data: { token: "tok" } });
    }
    expect.soft(request.headers.get("Authorization")).toBe("Bearer tok");
    if (request.url.pathname === "/v1/company/employees/attributes") {
      return json(200, { success: true, data: attributes });
    }
    if (request.url.pathname === "/v1/company/employees") {
      const index = Math.floor(Number(request.url.searchParams.get("offset")) / 100);
      return json(200, {
        success: true,
        metadata: { current_page: index, total_pages: pages.length },
        data: pages[index],
      });
    }
    return answer(404);
  };
}

function adapter(handler: Handler, config: Json = {}) {
  const fetch = mockFetch(handler);
  return [new PersonioAdapter({ ...CONFIG, ...config }, { fetch }), fetch] as const;
}

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("The promise did not fail");
}

describe("Personio", () => {
  it("pages through the employees and maps the fields", async () => {
    const boss = employee("1", "Ada", "Boss", {
      email: "ada@example.invalid",
      status: "active",
      hire_date: "2020-01-01T00:00:00+01:00",
      department: { type: "Department", attributes: { id: 7, name: "Engineering" } },
      employment_type: "internal",
    });
    const filler = Array.from({ length: 99 }, (_, index) =>
      employee(String(100 + index), "Filler", `P${100 + index}`, { status: "active" }),
    );
    const worker = employee("2", "Bo", "Worker", {
      email: "bo@example.invalid",
      status: "active",
      position: "Werkstudent",
      employment_type: "internal",
      hire_date: "01.03.2027",
      department: { type: "Department", attributes: { id: 7, name: "Engineering" } },
      supervisor: { type: "Employee", attributes: { id: attr(1) } },
    });
    const [personioAdapter, fetch] = adapter(personio([[boss, ...filler], [worker]]), {
      type_mapping: "werkstudent = intern\nnonsense = astronaut",
    });

    const people = new Map((await personioAdapter.listPeople()).map((record) => [record.externalId, record]));

    expect(people.size).toBe(101);
    const offsets = fetch.requests
      .filter((request) => request.url.pathname === "/v1/company/employees")
      .map((request) => request.url.searchParams.get("offset"));
    expect(offsets).toEqual(["0", "100"]);
    expect(people.get("1")!.startDate).toBe("2020-01-01");
    expect(people.get("1")!.team).toBe("Engineering");
    expect(people.get("1")!.personType).toBe("employee");
    const bo = people.get("2")!;
    expect([bo.firstName, bo.lastName, bo.workEmail]).toEqual(["Bo", "Worker", "bo@example.invalid"]);
    expect(bo.personType).toBe("intern");
    expect(bo.jobTitle).toBe("Werkstudent");
    expect(bo.startDate).toBe("2027-03-01");
    // Supervisor given only by Personio ID resolves to that person's work email.
    expect(bo.managerEmail).toBe("ada@example.invalid");
    expect(bo.active).toBe(true);
    // The token is fetched once.
    expect(fetch.requests.filter((request) => request.url.pathname === "/v1/auth")).toHaveLength(1);
  });

  it("discovers custom attributes by their label", async () => {
    const attributes = [
      { key: "dynamic_1", label: "Private E-Mail-Adresse", type: "standard" },
      { key: "dynamic_2", label: "Workplaces Supervisor", type: "standard" },
      { key: "dynamic_3", label: "Favorite color", type: "standard" },
      { key: "dynamic_4", label: "Cost center", type: "standard" },
    ];
    const record = employee("5", "Cy", "Custom", { status: "active", email: "cy@example.invalid" });
    record.attributes.dynamic_1 = { label: "Private E-Mail-Adresse", value: "cy@home.example.invalid" };
    record.attributes.dynamic_2 = {
      label: "Workplaces Supervisor",
      value: { type: "Employee", attributes: { id: attr(9), email: attr("lead@example.invalid") } },
    };
    record.attributes.dynamic_4 = { label: "Cost center", value: "Ops" };
    const [personioAdapter, fetch] = adapter(personio([[record]], attributes), {
      team_attribute: "Cost center",
    });

    const [cy] = await personioAdapter.listPeople();

    const listed = fetch.requests.filter((request) => request.url.pathname === "/v1/company/employees")[0]!;
    const keys = listed.url.searchParams.getAll("attributes[]");
    expect(keys.includes("dynamic_1") && keys.includes("dynamic_2") && keys.includes("dynamic_4")).toBe(true);
    expect(keys).not.toContain("dynamic_3");
    expect(cy!.personalEmail).toBe("cy@home.example.invalid");
    expect(cy!.managerEmail).toBe("lead@example.invalid");
    expect(cy!.team).toBe("Ops");
  });

  it("reads end dates and lists leavers for a while", async () => {
    const now = today();
    const future = addDays(now, 20);
    const recent = addDays(now, -5);
    const old = addDays(now, -90);
    const records = [
      // Termination date wins over the contract end date.
      employee("10", "Fu", "Ture", { status: "active", termination_date: future, contract_end_date: old }),
      // Left recently: listed as inactive.
      employee("11", "Re", "Cent", { status: "inactive", termination_date: recent }),
      // Left long ago: not listed.
      employee("12", "Ol", "D", { status: "inactive", termination_date: old }),
      // Inactive without a date: listed, so the app sees the change.
      employee("13", "No", "Date", { status: "terminated" }),
      // The last day at work wins over the termination date and ends access.
      employee("14", "La", "St", { status: "active", last_working_day: recent, termination_date: future }),
      // Past contract end without a status change: inactive.
      employee("15", "Co", "Ntract", { status: "active", end_date: recent }),
      // Last day at work long ago, employment ended recently: still listed.
      employee("16", "Wo", "Rk", { status: "inactive", last_working_day: old, termination_date: recent }),
    ];
    const [personioAdapter] = adapter(personio([records]));

    const people = new Map((await personioAdapter.listPeople()).map((record) => [record.externalId, record]));

    expect(new Set(people.keys())).toEqual(new Set(["10", "11", "13", "14", "15", "16"]));
    expect(people.get("10")).toMatchObject({
      endDate: future,
      contractEndDate: old,
      terminationDate: future,
      lastDayAtWork: null,
      active: true,
    });
    expect(people.get("11")!.active).toBe(false);
    expect(people.get("13")!.active === false && people.get("13")!.endDate === null).toBe(true);
    expect(people.get("14")).toMatchObject({
      endDate: recent,
      terminationDate: future,
      lastDayAtWork: recent,
      active: false,
    });
    expect(people.get("15")).toMatchObject({ endDate: recent, contractEndDate: recent, active: false });
    expect(people.get("16")!.endDate).toBe(old);
  });

  it("finds the last day at work by its label", async () => {
    const attributes = [{ key: "dynamic_7", label: "Letzter Arbeitstag", type: "standard" }];
    const record = employee("17", "Ju", "Ly", { status: "active" });
    record.attributes.dynamic_7 = { label: "Letzter Arbeitstag", value: "31.07.2099" };
    const [personioAdapter, fetch] = adapter(personio([[record]], attributes));

    const [july] = await personioAdapter.listPeople();

    const listed = fetch.requests.filter((request) => request.url.pathname === "/v1/company/employees")[0]!;
    expect(listed.url.searchParams.getAll("attributes[]")).toContain("dynamic_7");
    expect(july).toMatchObject({ lastDayAtWork: "2099-07-31", endDate: "2099-07-31" });
  });

  it("skips unreadable records and keeps the rest", async () => {
    const records = [
      employee("20", "Bad", "Date", { status: "active", hire_date: "next tuesday" }),
      employee("21", "", "Nameless", { status: "active" }),
      employee("22", "Good", "Record", { status: "active", employment_type: "external" }),
    ];
    const [personioAdapter] = adapter(personio([records]));

    const people = await personioAdapter.listPeople();

    expect(people.map((person) => person.externalId)).toEqual(["22"]);
    expect(people[0]!.personType).toBe("external");
    expect(personioAdapter.skipped.map(([recordId]) => recordId)).toEqual(["20", "21"]);
  });

  it("moves addresses outside the work email domains to the personal email", async () => {
    const records = [
      employee("30", "Wo", "Rk", { status: "active", email: "wo@corp.example.invalid" }),
      employee("31", "Pr", "Ivate", { status: "active", email: "pr@mail.example.invalid" }),
    ];
    const [personioAdapter] = adapter(personio([records]), { work_email_domains: "corp.example.invalid" });

    const people = new Map((await personioAdapter.listPeople()).map((record) => [record.externalId, record]));

    expect(people.get("30")!.workEmail).toBe("wo@corp.example.invalid");
    expect(people.get("31")!.workEmail).toBe("");
    expect(people.get("31")!.personalEmail).toBe("pr@mail.example.invalid");
  });

  it("treats rejected credentials as a configuration error", async () => {
    const [personioAdapter] = adapter(personio([[]], [], 401));

    const error = await failure(personioAdapter.testConnection());

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).not.toContain("s3cret-value");
  });

  it("treats a rate limit as transient", async () => {
    const [personioAdapter] = adapter((request) => {
      if (request.url.pathname === "/v1/auth") return json(200, { data: { token: "tok" } });
      return answer(429);
    });

    await expect(personioAdapter.listPeople()).rejects.toBeInstanceOf(TransientError);
  });

  it("treats an unexpected answer as an adapter error", async () => {
    const [personioAdapter] = adapter((request) => {
      if (request.url.pathname === "/v1/auth") return json(200, { data: { token: "tok" } });
      return json(200, { data: { not: "a list" } });
    });

    await expect(personioAdapter.listPeople()).rejects.toBeInstanceOf(AdapterError);
  });

  it("reports missing credentials before any call", async () => {
    const fetch = mockFetch(() => answer(500));
    const personioAdapter = new PersonioAdapter({ client_id: "client" }, { fetch });

    const error = await failure(personioAdapter.testConnection());

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toMatch(/Client secret/);
    expect(fetch.requests).toEqual([]);
  });

  it("reports the number of employees in the connection test", async () => {
    const [personioAdapter] = adapter(personio([[employee("40", "On", "E", { status: "active" })]]));

    const result = await personioAdapter.testConnection();

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Connected to Personio: 1 employee.");
  });

  it("reads the configured team attribute first", async () => {
    const page = [
      employee("1", "Ada", "Lovelace", { department: "Engineering", team: "Operations" }),
      employee("2", "Grace", "Hopper", { department: null, team: "Research" }),
    ];
    let [personioAdapter] = adapter(personio([page]), { team_attribute: "team" });
    let teams = Object.fromEntries(
      (await personioAdapter.listPeople()).map((record) => [record.externalId, record.team]),
    );
    expect(teams).toEqual({ 1: "Operations", 2: "Research" });
    [personioAdapter] = adapter(personio([page]));
    teams = Object.fromEntries(
      (await personioAdapter.listPeople()).map((record) => [record.externalId, record.team]),
    );
    expect(teams).toEqual({ 1: "Engineering", 2: "Research" });
  });

  // Not in the Python suite: the checks that replace Django's validate_email
  // and Python's date parsing, against the answers those gave.

  it.each([
    ["ada@example.invalid", true],
    ["Ada@Example.Invalid", true],
    ["ada@localhost", true],
    ["ada@[127.0.0.1]", true],
    ["ada@[::1]", true],
    ["ada@[999.1.1.1]", false],
    ["ada@[01.1.1.1]", false],
    ["!#$%&*+/=?^_`{|}~-@example.invalid", true],
    ['"quoted local"@example.invalid', false],
    ["a..b@example.invalid", false],
    [".a@example.invalid", false],
    ["ada@example", false],
    ["ada@example.c1", false],
    ["ada@-x.example.invalid", false],
    ["ada@exämple.example.invalid", true],
    ["ädä@example.invalid", false],
    ["ada@example." + "xn--p1ai", true],
    ["ada@example.invalid.", false],
    ["ada@@example.invalid", false],
    ["ada@ex_ample.example.invalid", false],
    [`${"x".repeat(64)}@${"y".repeat(250)}.invalid`, false],
    ["", false],
  ])("checks %s as Django's validate_email does", (value, valid) => {
    expect(isEmail(value)).toBe(valid);
  });

  it.each([
    ["2020-01-01", "2020-01-01"],
    ["20200101", "2020-01-01"],
    ["2021-W01-1", "2021-01-04"],
    ["2021W01", "2021-01-04"],
    ["2020-W53-1", "2020-12-28"],
    ["2020-01-01T00:00:00+01:00", "2020-01-01"],
    ["2020-01-01 00:00", "2020-01-01"],
    ["2020-01-01T00", "2020-01-01"],
    ["2020-01-01T00:00:00.123Z", "2020-01-01"],
    ["20200101T000000", "2020-01-01"],
    ["2020-01-01T12:00:00,5", "2020-01-01"],
    ["2020-01-01T12:00+0100", "2020-01-01"],
    ["1.3.2027", "2027-03-01"],
    ["01.03.2027", "2027-03-01"],
    ["2020-01-01T0", null],
    ["2020-01-01T24:00", null],
    ["2020-01-01T12:00:00+25:00", null],
    ["2020-0101", null],
    ["2020-02-30", null],
    ["2021-W53-1", null],
    ["31.02.2027", null],
    ["01.01.0000", null],
    ["1.3.27", null],
    ["next tuesday", null],
  ])("reads the date %s as Python does", (value, expected) => {
    const read = () => parseDate({ hire_date: value }, "hire_date");
    if (expected === null) expect(read).toThrow("unreadable date in hire_date");
    else expect(read()).toBe(expected);
  });
});
