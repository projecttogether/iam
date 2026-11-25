import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/utils";

/** A titled section of a record's page (a card with an h2), e.g. "History". */
export function Section(props: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={props.className}>
      <CardHeader>
        <CardTitle>
          <h2>{props.title}</h2>
        </CardTitle>
        {props.description ? <CardDescription>{props.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4">{props.children}</CardContent>
    </Card>
  );
}

/** Labelled values in a grid: one column on phones, more on wider screens. */
export function Details({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>{children}</dl>;
}

/** One labelled value of `Details`. */
export function Detail(props: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-0.5", props.className)}>
      <dt className="text-muted-foreground text-xs">{props.label}</dt>
      <dd className="text-sm break-words">{props.children}</dd>
    </div>
  );
}
