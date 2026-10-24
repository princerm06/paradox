import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";

export type BranchEdgeData = {
  running?: boolean;
  ghost?: boolean;
  tone?: "live" | "selected" | "quiet";
};

function readData(data: unknown): BranchEdgeData {
  if (!data || typeof data !== "object") return {};
  return data as BranchEdgeData;
}

const STROKE: Record<NonNullable<BranchEdgeData["tone"]>, string> = {
  live: "#3ee0c5",
  selected: "#8b7cff",
  quiet: "#4a5570",
};

/** Clears the card border so the bead sits on the path rather than under the node. */
const BEAD_GAP = 3;

function beadOffset(position: Position): { x: number; y: number } {
  if (position === Position.Left) return { x: -BEAD_GAP, y: 0 };
  if (position === Position.Right) return { x: BEAD_GAP, y: 0 };
  if (position === Position.Top) return { x: 0, y: -BEAD_GAP };
  return { x: 0, y: BEAD_GAP };
}

export function BranchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  interactionWidth,
  data,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.42,
  });
  const branch = readData(data);
  const tone = branch.tone ?? "quiet";
  const stroke = STROKE[tone];
  const lit = tone !== "quiet";
  // A generation that never became a timeline reads as an unfinished branch.
  const unfinished = Boolean(branch.ghost) && !branch.running;
  const bead = beadOffset(sourcePosition);

  return (
    <g className={`branch-edge tone-${tone}${lit ? " is-lit" : ""}`}>
      {lit ? (
        <BaseEdge
          id={`${id}-halo`}
          path={path}
          interactionWidth={0}
          style={{ stroke, strokeWidth: 6, strokeLinecap: "round", opacity: 0.13 }}
        />
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        style={{
          stroke,
          strokeWidth: lit ? 1.9 : 1.2,
          strokeLinecap: "round",
          strokeDasharray: unfinished ? "3 5" : undefined,
          opacity: unfinished ? 0.88 : 1,
        }}
      />
      {/* One bead per parent port. Siblings share the point, so the lit tone wins
          on top and the fan-out reads as a single junction. */}
      <circle className="branch-junction" cx={sourceX + bead.x} cy={sourceY + bead.y} r={lit ? 2.6 : 2} style={{ fill: stroke }} />
      {branch.running ? <path d={path} className="branch-flow" fill="none" /> : null}
    </g>
  );
}
