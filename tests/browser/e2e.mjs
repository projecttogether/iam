// End-to-end check against the development stack (compose.dev.yaml): signs in
// through the real Keycloak, connects Keycloak and Mailpit in the admin
// section, builds an access profile and a team, onboards and offboards a
// person, and checks Keycloak and Mailpit directly. Needs the app on BASE_URL
// (with its web app built) and a worker running.
//
//   node tests/browser/e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL || "http://localhost:8000";
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || "http://localhost:8098";
const MAILPIT_URL = process.env.MAILPIT_URL || "http://localhost:8027";
const SMTP_HOST = process.env.SMTP_HOST || "localhost";
const SMTP_PORT = process.env.SMTP_PORT || "1027";
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(import.meta.dirname, "../../test-results");
const RUN = Date.now().toString(36);
const LOGIN = `grace.${RUN}`;
const WORK_EMAIL = `${LOGIN}@example.invalid`;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function keycloakAdmin(pathname) {
  const token = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: "admin",
    }),
  }).then((r) => r.json());
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/iam${pathname}`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  return response.json();
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`), fullPage: true });
}

/** The toast a button's action answers with: the first one that was not there before the click. */
async function toastAfter(page, button) {
  const toasts = page.locator("[data-sonner-toast]");
  const before = new Set(
    await toasts.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-index") + item.innerText),
    ),
  );
  await button.click();
  for (let i = 0; i < 300; i += 1) {
    const now = await toasts.evaluateAll((items) =>
      items.map((item) => ({
        key: item.getAttribute("data-index") + item.innerText,
        text: item.innerText,
        type: item.getAttribute("data-type"),
      })),
    );
    const fresh = now.find((item) => !before.has(item.key));
    if (fresh) return fresh;
    await page.waitForTimeout(100);
  }
  throw new Error("No toast appeared");
}

async function waitForWorkflow(page, status) {
  await page.waitForURL(/\/workflows\/\d+$/);
  for (let i = 0; i < 40; i += 1) {
    const heading = await page.locator("h1").innerText();
    if (heading.includes(status)) return;
    await page.waitForTimeout(1000);
    await page.reload();
  }
  throw new Error(`Workflow did not reach "${status}": ${await page.locator("h1").innerText()}`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Sign in through Keycloak; /iam/admins makes the user an admin.
  await page.goto(`${BASE_URL}/`);
  await page.waitForURL(/\/login/);
  await shot(page, "01-login");
  await page.getByRole("link", { name: "Sign in with Keycloak" }).click();
  await page.waitForURL((url) => url.origin === new URL(KEYCLOAK_URL).origin);
  await page.fill("#username", "admin");
  await page.fill("#password", "admin");
  await page.click("#kc-login");
  await page.waitForURL(`${BASE_URL}/`);
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  console.log("Signed in through Keycloak as admin");

  // Connect Keycloak in the admin section.
  await page.goto(`${BASE_URL}/admin/connections/new/keycloak`);
  await page.getByLabel("Name", { exact: true }).fill(`Keycloak ${RUN}`);
  await page.getByLabel("Keycloak URL").fill(KEYCLOAK_URL);
  await page.getByLabel("Realm").fill("iam");
  await page.getByLabel("Client ID").fill("iam-provisioner");
  // A secret stays hidden until the eye button shows it.
  const secret = page.getByLabel("Client secret");
  await secret.fill("iam-dev-provisioner-secret");
  assert.equal(await secret.getAttribute("type"), "password");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  assert.equal(await secret.getAttribute("type"), "text");
  await page.getByLabel("Send setup email").check();
  await page.getByLabel("Enabled").check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/admin\/connections\/\d+$/);
  const keycloakUrl = page.url();
  const tested = await toastAfter(page, page.getByRole("button", { name: "Test connection" }));
  assert.match(tested.text, /user/i, tested.text);
  console.log(`Keycloak test: ${tested.text}`);
  await toastAfter(page, page.getByRole("button", { name: "Import groups" }));
  await page.getByText("/apps/wiki", { exact: true }).first().waitFor();
  await shot(page, "02-keycloak-connection");

  // Connect Mailpit as the email connection.
  await page.goto(`${BASE_URL}/admin/connections/new/smtp`);
  await page.getByLabel("Name", { exact: true }).fill(`Mailpit ${RUN}`);
  await page.getByLabel("SMTP server").fill(SMTP_HOST);
  await page.getByLabel("Port").fill(SMTP_PORT);
  await page.getByLabel("Encryption").selectOption("none");
  await page.getByLabel("From address").fill("iam@example.invalid");
  await page.getByLabel("Enabled").check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/admin\/connections\/\d+$/);
  const mailTest = await toastAfter(page, page.getByRole("button", { name: "Test connection" }));
  assert.equal(mailTest.type, "success", mailTest.text);

  // Policy: an access profile with two app groups and a team with its group.
  await page.goto(`${BASE_URL}/profiles/new`);
  await page.getByLabel("Name", { exact: true }).fill(`Staff ${RUN}`);
  const grant = page.getByRole("group", { name: `Keycloak ${RUN}`, exact: true });
  await grant.getByLabel(`Account in Keycloak ${RUN}`).check();
  await grant.getByLabel("/apps/wiki", { exact: true }).check();
  await grant.getByLabel("/apps/chat", { exact: true }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/profiles\/\d+$/);
  await page.goto(`${BASE_URL}/teams/new`);
  await page.getByLabel("Name", { exact: true }).fill(`Product ${RUN}`);
  await page
    .getByRole("group", { name: new RegExp(`Keycloak ${RUN}`) })
    .getByLabel("/teams/product", { exact: true })
    .check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/teams\/\d+$/);

  // Add a person and onboard them.
  await page.goto(`${BASE_URL}/people/new`);
  await page.getByLabel("First name").fill("Grace");
  await page.getByLabel("Last name").fill(`Hopper ${RUN}`);
  await page.getByLabel("Work email").fill(WORK_EMAIL);
  await page.getByLabel("Personal email").fill(`${LOGIN}@personal.example.invalid`);
  await page.getByLabel("Team").selectOption({ label: `Product ${RUN}` });
  await page.getByLabel("Access profile").selectOption({ label: `Staff ${RUN}` });
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/people\/\d+$/);
  const personUrl = page.url();
  await page.getByRole("button", { name: "Start onboarding" }).click();
  await waitForWorkflow(page, "Completed");
  await shot(page, "03-onboarding-completed");
  console.log("Onboarding completed");

  let [user] = await keycloakAdmin(`/users?username=${LOGIN}&exact=true`);
  assert.ok(user, "Keycloak user was created");
  assert.equal(user.enabled, true);
  assert.equal(user.email, WORK_EMAIL);
  let groups = (await keycloakAdmin(`/users/${user.id}/groups`)).map((g) => g.path).sort();
  assert.deepEqual(groups, ["/apps/chat", "/apps/wiki", "/teams/product"]);
  console.log(`Keycloak user ${LOGIN}: enabled, groups ${groups.join(", ")}`);

  const messages = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${WORK_EMAIL}`)}`,
  ).then((r) => r.json());
  assert.ok(messages.messages_count >= 1, "Keycloak sent the setup email");
  console.log(`Mailpit: setup email "${messages.messages[0].Subject}" to ${WORK_EMAIL}`);

  await page.goto(personUrl);
  await page.getByRole("heading", { name: new RegExp(`Grace Hopper ${RUN}`) }).waitFor();
  await shot(page, "04-person");

  // Offboard: the account is disabled and loses its managed groups.
  await page.getByRole("button", { name: "Start offboarding" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Start offboarding" }).click();
  await waitForWorkflow(page, "Completed");
  [user] = await keycloakAdmin(`/users?username=${LOGIN}&exact=true`);
  assert.equal(user.enabled, false);
  groups = await keycloakAdmin(`/users/${user.id}/groups`);
  assert.deepEqual(groups, []);
  console.log("Offboarding completed: Keycloak user disabled, managed groups removed");

  // The account comparison finds the account and reports no unexpected access.
  await page.goto(keycloakUrl);
  const compared = await toastAfter(page, page.getByRole("button", { name: "Compare accounts now" }));
  assert.equal(compared.type, "success", compared.text);
  await shot(page, "05-connection-after-compare");

  await page.goto(`${BASE_URL}/audit`);
  await page.getByText(`Disabled the Keycloak ${RUN} account of Grace Hopper ${RUN}`).first().waitFor();
  await shot(page, "06-audit");
  await page.goto(`${BASE_URL}/`);
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  await shot(page, "07-dashboard");

  // Sign out through the user menu: the provider ends its session too.
  await page.getByRole("button", { name: /admin@example\.invalid/i }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  console.log("Signed out through Keycloak");
  assert.deepEqual(errors, [], `Page errors: ${errors.join("; ")}`);
  console.log(`End-to-end check passed; screenshots in ${OUTPUT_DIR}`);
} finally {
  await browser.close();
}
