import { Adapter, displayName, field, type AccountSpec, type JobActionName, type TestResult } from "./base";

/** Any app without an API: every change becomes a task for a person. */
export class ManualAdapter extends Adapter {
  static override readonly slug = "manual";
  static override readonly label = "Other app (manual tasks)";
  static override readonly description =
    "Tracks accounts in an app without automation. Each account or group change " +
    "becomes a task with the steps below; completing the task records the change.";
  static override readonly supportsWrite = false;
  static override readonly supportsGroups = true;
  static override readonly supportsAccountListing = false;
  static override readonly manualGroups = true;
  static override readonly fields = [
    field("app_name", "App name", { required: true, placeholder: "Figma" }),
    field("admin_url", "Admin page", { kind: "url", help: "Linked in every task." }),
    field("instructions", "Instructions", {
      kind: "textarea",
      help: "Added to every task, e.g. which license to assign.",
    }),
  ];

  get appName(): string {
    return this.setting("app_name", "the app");
  }

  override async testConnection(): Promise<TestResult> {
    return { ok: true, message: "Manual connections need no test: changes become tasks." };
  }

  override manualInstructions(action: JobActionName, spec: AccountSpec, groups: string[]): string {
    const who = `${displayName(spec)} (${spec.email || spec.username})`;
    const lines: string[] = [];
    if (action === "disable_account") {
      lines.push(`Remove or disable the ${this.appName} account of ${who}.`);
    } else {
      lines.push(`Make sure ${who} has an active ${this.appName} account.`);
      if (groups.length > 0) lines.push(`Groups: ${groups.join(", ")}.`);
    }
    if (this.setting("admin_url")) lines.push(`Admin page: ${this.setting<string>("admin_url")}`);
    if (this.setting("instructions")) lines.push(this.setting<string>("instructions"));
    return lines.join("\n");
  }
}
