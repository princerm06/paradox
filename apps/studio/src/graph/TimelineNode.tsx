import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { formatRelative, formatStamp } from "../lib/format.ts";
import { useAskInspect } from "../shell/inspect.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { InspectButton, Lineage, LiveChip, StatusChip, type StateKind } from "./NodeChrome.tsx";
import type { TimelineFlowNode, TimelineNodeData } from "./layout.ts";

function lifecycle(data: TimelineNodeData): StateKind {
  if (data.isRoot) return "root";
  if (data.isPending) return "pending";
  if (data.isDeclined) return "declined";
  if (data.isConfirmed) return "confirmed";
  return "unknown";
}

const HINTS: Partial<Record<StateKind, string>> = {
  root: "The original codebase every future branches from",
  pending: "Built and awaiting your confirmation — not generating",
  confirmed: "Confirmed and kept in the timeline history",
  declined: "Declined — kept for reference, outside the working history",
};

export const TimelineNode = memo(function TimelineNode({ id, data }: NodeProps<TimelineFlowNode>) {
  const { selectedId, selectedGenerationId, selectTimeline } = useWorkspace();
  const askInspect = useAskInspect();
  const selected = selectedGenerationId === null && selectedId === id;
  const kind = lifecycle(data);
  const className = [
    "future-node",
    "nodrag",
    "nopan",
    `state-${kind}`,
    selected ? "is-selected" : "",
    data.isActive ? "is-live" : "",
    data.isPending ? "is-pending" : "",
    data.isDeclined ? "is-declined" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const relation = data.isRoot ? "Root codebase" : data.parentName ? `From ${data.parentName}` : null;
  const when = formatRelative(data.createdAt);
  // Names ellipsise at this width; the tooltip keeps the full one reachable.
  const lineageHint = [relation, `Created ${formatStamp(data.createdAt)}`].filter(Boolean).join(" · ");
  const label = [
    data.name,
    data.statusText,
    data.isActive ? "live, serving the running application" : null,
    selected ? "selected" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className={className} title={data.modificationText ? `Change: ${data.modificationText}` : undefined}>
      {data.isRoot ? null : <Handle type="target" position={Position.Left} isConnectable={false} />}
      <button type="button" className="future-select" aria-pressed={selected} aria-label={label} onClick={() => selectTimeline(id)}>
        <span className="future-head">
          <span className="future-name" title={data.name}>
            {data.name}
          </span>
          {data.isActive ? <LiveChip /> : null}
        </span>
        <Lineage relation={relation} when={when || null} hint={lineageHint} />
      </button>
      <span className="future-foot">
        <StatusChip kind={kind} label={data.statusText} hint={HINTS[kind]} />
        <InspectButton
          name={data.name}
          onClick={() => {
            selectTimeline(id);
            askInspect();
          }}
        />
      </span>
      {data.hasChildren ? <Handle type="source" position={Position.Right} isConnectable={false} /> : null}
    </div>
  );
});
