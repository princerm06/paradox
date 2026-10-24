import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useWorkspace } from "../state/workspace.tsx";
import type { GhostFlowNode } from "./layout.ts";

export const GhostNode = memo(function GhostNode({ data }: NodeProps<GhostFlowNode>) {
  const { selectedGenerationId, selectGeneration } = useWorkspace();
  const selected = selectedGenerationId === data.generationId;
  const className = [
    "future-node",
    "is-ghost",
    "nodrag",
    "nopan",
    selected ? "is-selected" : "",
    data.isRunning ? "is-running" : "",
    data.isFailed ? "is-failed" : "",
    data.isCancelled ? "is-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <button
        type="button"
        className={className}
        aria-pressed={selected}
        aria-label={`${data.name}, ${data.statusText}${selected ? ", selected" : ""}`}
        onClick={() => selectGeneration(data.generationId)}
      >
        <span className="future-top">
          <span className="future-name">{data.name}</span>
        </span>
        <span className="future-status">{data.statusText}</span>
      </button>
    </>
  );
});
