import { Badge } from "@/components/ui/badge";
import { CONNECTION_STATUS_LABELS, type ConnectionStatus } from "@iam/shared/labels";
import { StatusBadge } from "@/components/status";

/** The state of a connection: its status when it is on, else "Off". */
export function ConnectionState({ enabled, status }: { enabled: boolean; status: ConnectionStatus }) {
  if (!enabled) return <Badge variant="outline">Off</Badge>;
  return <StatusBadge value={status} labels={CONNECTION_STATUS_LABELS} />;
}
