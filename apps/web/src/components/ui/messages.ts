import { defineMessages } from "@/i18n";

/** Words the components share. */
export const common = defineMessages({
  en: {
    cancel: "Cancel",
    confirm: "Confirm",
    back: "Back",
    next: "Next",
    loading: "Loading…",
    retry: "Retry",
    copy: "Copy",
    copied: "Copied",
    error: "Something went wrong",
    page: "Page {page} of {pages}",
    total: "{count} entries",
    total_one: "1 entry",
    close: "Close",
    sidebar: "Sidebar",
    sidebarDescription: "The app's navigation.",
    toggleSidebar: "Show or hide the sidebar",
  },
});

/** The message of an error of any kind; English fallback for values without one. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error !== "") return error;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message !== "") return message;
  return "Something went wrong";
}
