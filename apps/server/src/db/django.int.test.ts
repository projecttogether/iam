import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateWith } from "./migrate";
import { databaseUrl, MIGRATIONS, recreateDatabase } from "../test/databases";
import { TEST_DATABASE_URL } from "../test/env";
import { decrypt } from "../core/crypto";
import { overrideConfigForTests, config } from "../config";

const here = path.dirname(fileURLToPath(import.meta.url));
/** A database of IAM 0.2.0 (Django), with demo data, a workflow and an encrypted secret. */
const FIXTURE = fs.readFileSync(path.join(here, "fixtures/django-0.2.sql"), "utf8");
/** The ENCRYPTION_KEY the fixture's secrets were encrypted with. */
const FIXTURE_KEY = "zIi4BBQnf3ojuqE3UQQ1yUmP0zpMlTv44ATyCo-nt9E=";

const DJANGO = databaseUrl(TEST_DATABASE_URL, "iam_test_django");
const FRESH = databaseUrl(TEST_DATABASE_URL, "iam_test_fresh");

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function loadFixture() {
  await recreateDatabase(DJANGO, { empty: true });
  // The dump empties search_path for its session: a client of its own.
  await withClient(DJANGO, (client) => client.query(FIXTURE));
}

/** Takes over and migrates as the migrate role does. */
async function upgrade(url: string) {
  return withClient(url, (client) => migrateWith(client, MIGRATIONS));
}

/** Columns, constraints and indexes of the app's tables, for comparing two databases. */
async function catalog(url: string) {
  return withClient(url, async (client) => {
    const columns = await client.query(`
      select table_name, column_name, data_type, character_maximum_length, is_nullable,
             column_default, is_identity, identity_generation
      from information_schema.columns
      where table_schema = 'public' and table_name like 'iam\\_%'
        and not (table_name = 'iam_user' and column_name = 'password')
      order by table_name, column_name
    `);
    const constraints = await client.query(`
      select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where connamespace = 'public'::regnamespace and conrelid::regclass::text like 'iam\\_%'
        and conname <> 'iam_user_password_not_null'
      order by 1, 2
    `);
    const indexes = await client.query(`
      select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename like 'iam\\_%'
      order by 1, 2
    `);
    const sequences = await client.query(`
      select sequence_name, data_type, start_value, increment from information_schema.sequences
      where sequence_schema = 'public' and sequence_name like 'iam\\_%' order by 1
    `);
    return {
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      sequences: sequences.rows,
    };
  });
}

describe("taking over the database of the Django version", () => {
  beforeAll(async () => {
    await recreateDatabase(FRESH);
  });

  afterAll(async () => {
    await withClient(databaseUrl(TEST_DATABASE_URL, "postgres"), async (client) => {
      await client.query("drop database if exists iam_test_django with (force)");
      await client.query("drop database if exists iam_test_fresh with (force)");
    });
  });

  it("ends with the schema of a new database, and keeps every row", async () => {
    await loadFixture();
    const before = await withClient(DJANGO, (client) =>
      client.query(`
        select (select count(*) from iam_person) as people, (select count(*) from iam_job) as jobs,
               (select count(*) from iam_task) as tasks, (select count(*) from iam_auditevent) as events,
               (select count(*) from iam_user) as users, (select count(*) from iam_account) as accounts
      `),
    );
    expect(await upgrade(DJANGO)).toBe(true);
    expect(await catalog(DJANGO)).toEqual(await catalog(FRESH));
    const after = await withClient(DJANGO, (client) =>
      client.query(`
        select (select count(*) from iam_person) as people, (select count(*) from iam_job) as jobs,
               (select count(*) from iam_task) as tasks, (select count(*) from iam_auditevent) as events,
               (select count(*) from iam_user) as users, (select count(*) from iam_account) as accounts
      `),
    );
    expect(after.rows).toEqual(before.rows);
    // A name an admin chose stays (drizzle/0006_organization_name_default.sql).
    const settings = await withClient(DJANGO, (client) =>
      client.query("select organization_name from iam_appsettings"),
    );
    expect(settings.rows).toEqual([{ organization_name: "Example" }]);
    expect(Number(before.rows[0].people)).toBe(4);
    expect(Number(before.rows[0].jobs)).toBeGreaterThan(0);
  });

  it("ends Django's sessions at every migration, and keeps their table", async () => {
    const addSession = () =>
      withClient(DJANGO, (client) =>
        client.query(
          "insert into django_session (session_key, session_data, expire_date) values ($1, 'data', now() + interval '1 day')",
          [`key-${Math.random().toString(36).slice(2)}`],
        ),
      );
    const count = () =>
      withClient(DJANGO, async (client) =>
        Number((await client.query("select count(*) from django_session")).rows[0].count),
      );
    await loadFixture();
    await addSession();
    expect(await upgrade(DJANGO)).toBe(true);
    expect(await count()).toBe(0);
    // A session of 0.2 after a rollback ends at the next upgrade.
    await addSession();
    expect(await upgrade(DJANGO)).toBe(false);
    expect(await count()).toBe(0);
  });

  it("ends the sessions of people who signed in on 0.2 after a rollback", async () => {
    await loadFixture();
    expect(await upgrade(DJANGO)).toBe(true);
    await withClient(DJANGO, async (client) => {
      // Two people signed in on 0.3 twice each (two browsers), then signed
      // out of the newer session: the older one stays theirs.
      const { rows } = await client.query<{ id: string }>("select id from iam_user order by id limit 2");
      expect(rows).toHaveLength(2);
      for (const { id } of rows) {
        await client.query(
          `insert into iam_session (id, user_id, created_at, expires_at, id_token)
           values (md5(random()::text) || md5(random()::text), $1, '2026-11-20T09:00:00Z', now() + interval '1 day', '')`,
          [id],
        );
        await client.query(
          "update iam_user set last_login = '2026-11-20T10:00:00Z', last_session_at = '2026-11-20T10:00:00Z' where id = $1",
          [id],
        );
      }
      // After a rollback, the first signed in (and maybe out) on 0.2.
      await client.query("update iam_user set last_login = '2026-11-20T11:00:00Z' where id = $1", [
        rows[0]!.id,
      ]);
    });
    expect(await upgrade(DJANGO)).toBe(false);
    const left = await withClient(DJANGO, async (client) =>
      (await client.query<{ user_id: string }>("select user_id from iam_session")).rows.map((row) =>
        String(row.user_id),
      ),
    );
    const ids = await withClient(DJANGO, async (client) =>
      (await client.query<{ id: string }>("select id from iam_user order by id limit 2")).rows.map((row) =>
        String(row.id),
      ),
    );
    expect(left).toEqual([ids[1]]);
  });

  it("does nothing the second time", async () => {
    expect(await upgrade(DJANGO)).toBe(false);
    expect(await upgrade(FRESH)).toBe(false);
  });

  it("reads the secrets Django encrypted", async () => {
    const { rows } = await withClient(DJANGO, (client) =>
      client.query("select secret_data from iam_connection where adapter = 'scim'"),
    );
    const keys = config().encryptionKeys;
    overrideConfigForTests({ encryptionKeys: [FIXTURE_KEY] });
    try {
      expect(JSON.parse(decrypt(rows[0].secret_data))).toEqual({ token: "scim-secret-token-from-django" });
    } finally {
      overrideConfigForTests({ encryptionKeys: keys });
    }
  });

  it("applies the rules on delete that Django applied itself", async () => {
    await withClient(DJANGO, async (client) => {
      await client.query("begin");
      try {
        await client.query("delete from iam_team where name = 'Product'");
        const team = await client.query(
          "select count(*)::int as n from iam_person where team_id is not null",
        );
        expect(team.rows[0].n).toBe(0);
        await expect(client.query("delete from iam_accessprofile where name = 'Staff'")).rejects.toThrow(
          /foreign key/,
        );
      } finally {
        await client.query("rollback");
      }
      await client.query("begin");
      try {
        await client.query("delete from iam_person where first_name = 'Ada'");
        const jobs = await client.query("select count(*)::int as n from iam_job");
        expect(jobs.rows[0].n).toBe(0);
      } finally {
        await client.query("rollback");
      }
    });
  });

  it("lets new app users in while Django's password column stays", async () => {
    await withClient(DJANGO, async (client) => {
      const { rows } = await client.query(
        "insert into iam_user (email, display_name, role, role_source, is_active, created_at) " +
          "values ('new@example.invalid', '', 'viewer', 'local', true, now()) returning password",
      );
      expect(rows[0].password).toBe("");
    });
  });

  it("takes over a database of 0.1 that lacks Django's later migrations", async () => {
    await loadFixture();
    await withClient(DJANGO, async (client) => {
      await client.query("alter table iam_job drop column claim");
      await client.query("alter table iam_person drop column onboarding_paused");
      await client.query("delete from django_migrations where app = 'iam' and name <> '0001_initial'");
    });
    expect(await upgrade(DJANGO)).toBe(true);
    expect(await catalog(DJANGO)).toEqual(await catalog(FRESH));
    const { rows } = await withClient(DJANGO, (client) =>
      client.query("select name from django_migrations where app = 'iam' order by name"),
    );
    expect(rows.map((row) => row.name)).toEqual([
      "0001_initial",
      "0002_job_claim",
      "0003_person_onboarding_paused",
      "0004_job_rehearsed",
    ]);
  });

  it("refuses a database that lacks a column of IAM 0.2, and changes nothing", async () => {
    await loadFixture();
    await withClient(DJANGO, (client) =>
      client.query("alter table iam_person drop column work_email cascade"),
    );
    await expect(upgrade(DJANGO)).rejects.toThrow(/iam_person.work_email is missing/);
    const { rows } = await withClient(DJANGO, (client) =>
      client.query("select to_regclass('drizzle.__drizzle_migrations') is null as untouched"),
    );
    expect(rows[0].untouched).toBe(true);
  });

  it("refuses IAM tables without migration records", async () => {
    await loadFixture();
    await withClient(DJANGO, (client) => client.query("drop table django_migrations"));
    await expect(upgrade(DJANGO)).rejects.toThrow(/neither Django's nor this version's migration records/);
  });
});
