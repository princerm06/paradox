import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useWorkspace } from "../state/workspace.tsx";
import type { TimelineFlowNode } from "./layout.ts";

export const TimelineNode = memo(function TimelineNode({ id, data }: NodeProps<TimelineFlowNode>) {
  const { selectedId, selectedGenerationId, selectTimeline } = useWorkspace();
  const selected = selectedGenerationId === null && selectedId === id;
  const className = [
    "future-node",
    "nodrag",
    "nopan",
    selected ? "is-selected" : "",
    data.isActive ? "is-live" : "",
    data.isPending ? "is-pending" : "",
    data.isDeclined ? "is-declined" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {data.isRoot ? null : <Handle type="target" position={Position.Top} isConnectable={false} />}
      <button
        type="button"
        className={className}
        aria-pressed={selected}
        aria-label={`${data.name}, ${data.statusText}${data.isActive ? ", live" : ""}${selected ? ", selected" : ""}`}
        onClick={() => selectTimeline(id)}
      >
        <span className="future-top">
          <span className="future-name">{data.name}</span>
          {data.isActive ? <span className="live-pill">Live</span> : null}
        </span>
        <span className="future-status">{data.statusText}</span>
      </button>
      {data.hasChildren ? <Handle type="source" position={Position.Bottom} isConnectable={false} /> : null}
    </>
  );
});
