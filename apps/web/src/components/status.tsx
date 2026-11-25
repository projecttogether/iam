import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/utils";
import { toneOf, type Tone } from "@iam/shared/labels";

const TONE_CLASSES: Record<Exclude<Tone, "danger" | "neutral">, string> = {
  ok: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  info: "border-transparent bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  warn: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
};

/** A small colored label for a status value: green, blue, amber, red or neutral. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  if (tone === "danger")
    return (
      <Badge variant="destructive" className={className}>
        {children}
      </Badge>
    );
  if (tone === "neutral")
    return (
      <Badge variant="secondary" className={className}>
        {children}
      </Badge>
    );
  return <Badge className={cn(TONE_CLASSES[tone], className)}>{children}</Badge>;
}

/** The badge of a status, colored by its value, labelled with `labels`. */
export function StatusBadge<T extends string>({ value, labels }: { value: T; labels: Record<T, string> }) {
  return <ToneBadge tone={toneOf(value)}>{labels[value] ?? value.replaceAll("_", " ")}</ToneBadge>;
}
