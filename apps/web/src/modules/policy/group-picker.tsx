import type { ReactNode } from "react";
import type { GroupConnection } from "@iam/shared/api/iam";
import { CheckboxField } from "@/components/form-fields";

/** The groups of one connection as checkboxes, or a note that none are imported yet. */
export function GroupChecklist({
  connection,
  selected,
  onToggle,
  idPrefix,
  emptyText,
}: {
  connection: GroupConnection;
  selected: ReadonlySet<number>;
  onToggle: (groupId: number, checked: boolean) => void;
  idPrefix: string;
  emptyText: ReactNode;
}) {
  if (connection.groups.length === 0) return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {connection.groups.map((group) => (
        <CheckboxField
          key={group.id}
          id={`${idPrefix}-${group.id}`}
          label={group.label}
          checked={selected.has(group.id)}
          onChange={(checked) => onToggle(group.id, checked)}
        />
      ))}
    </div>
  );
}

/**
 * The groups of a team: per account connection with groups, its groups as
 * checkboxes (as the Django version's group picker).
 */
export function GroupPicker({
  connections,
  selected,
  onToggle,
}: {
  connections: GroupConnection[];
  selected: ReadonlySet<number>;
  onToggle: (groupId: number, checked: boolean) => void;
}) {
  const withGroups = connections.filter((connection) => connection.supportsGroups);
  if (withGroups.length === 0) {
    return <p className="text-muted-foreground text-sm">No account connection with groups yet.</p>;
  }
  return (
    <div className="grid gap-3">
      {withGroups.map((connection) => (
        <fieldset key={connection.id} className="grid gap-3 rounded-lg border p-4">
          <legend className="sr-only">
            {connection.name}: {connection.groupLabel}
            {connection.enabled ? "" : " (turned off)"}
          </legend>
          <div className="flex flex-wrap items-baseline justify-between gap-2" aria-hidden>
            <span className="font-medium">{connection.name}</span>
            <span className="text-muted-foreground text-sm">
              {connection.groupLabel}
              {connection.enabled ? "" : " · turned off"}
            </span>
          </div>
          <GroupChecklist
            connection={connection}
            selected={selected}
            onToggle={onToggle}
            idPrefix="group"
            emptyText={`No ${connection.groupLabel.toLowerCase()} imported yet. Import them on the connection page.`}
          />
        </fieldset>
      ))}
    </div>
  );
}
