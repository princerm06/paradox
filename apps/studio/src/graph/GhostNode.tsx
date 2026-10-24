import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { formatRelative, formatStamp } from "../lib/format.ts";
import { useAskInspect } from "../shell/inspect.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { InspectButton, Lineage, StatusChip, type StateKind } from "./NodeChrome.tsx";
import type { GhostFlowNode, GhostNodeData } from "./layout.ts";

function phase(data: GhostNodeData): StateKind {
  if (data.isFailed) return "failed";
  if (data.isCancelled) return "cancelled";
  if (data.isSucceeded) return "confirmed";
  if (data.isRunning) return "running";
  return "unknown";
}

const HINTS: Partial<Record<StateKind, string>> = {
  running: "Generation in progress — no timeline exists yet",
  failed: "Generation stopped at this stage — no timeline was created",
  cancelled: "Generation cancelled — no timeline was created",
  confirmed: "Generation finished without a timeline on record",
};

export const GhostNode = memo(function GhostNode({ data }: NodeProps<GhostFlowNode>) {
  const { selectedGenerationId, selectGeneration } = useWorkspace();
  const askInspect = useAskInspect();
  const selected = selectedGenerationId === data.generationId;
  const kind = phase(data);
  const className = [
    "future-node",
    "is-ghost",
    "nodrag",
    "nopan",
    `state-${kind}`,
    selected ? "is-selected" : "",
    data.isRunning ? "is-running" : "",
    data.isFailed ? "is-failed" : "",
    data.isCancelled ? "is-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const when = formatRelative(data.createdAt);
  const relation = data.parentName ? `From ${data.parentName}` : null;
  // Names ellipsise at this width; the tooltip keeps the full one reachable.
  const lineageHint = [relation, `Attempted ${formatStamp(data.createdAt)}`].filter(Boolean).join(" · ");
  const label = ["Attempted future", data.name, data.statusText, selected ? "selected" : null].filter(Boolean).join(", ");

  return (
    <div className={className} title={`Generated with ${data.provider}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="future-select"
        aria-pressed={selected}
        aria-label={label}
        onClick={() => selectGeneration(data.generationId)}
      >
        <span className="future-head">
          <span className="future-name" title={data.name}>
            {data.name}
          </span>
          <span className="ghost-tag">Attempt</span>
        </span>
        <Lineage relation={relation} when={when || null} hint={lineageHint} />
      </button>
      <span className="future-foot">
        <StatusChip kind={kind} label={data.statusText} hint={HINTS[kind]} />
        <InspectButton
          name={data.name}
          onClick={() => {
            selectGeneration(data.generationId);
            askInspect();
          }}
        />
      </span>
    </div>
  );
});
