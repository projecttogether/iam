import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFormatter } from "@/lib/format";

/** A relative time ("3 hours ago", "in 2 hours") with the exact time in a tooltip. */
export function When({ value, empty }: { value: string | null | undefined; empty?: ReactNode }) {
  const format = useFormatter();
  if (!value) return <span className="text-muted-foreground">{empty ?? "—"}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={value}
          tabIndex={0}
          className="decoration-muted-foreground/50 cursor-default underline decoration-dotted underline-offset-4"
        >
          {format.relative(value)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{format.dateTime(value)}</TooltipContent>
    </Tooltip>
  );
}
