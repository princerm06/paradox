import { memo } from "react";
import type { ArchModel, ArchNode } from "./model.ts";

const W = 1000;
const H = 560;

function center(node: ArchNode): { x: number; y: number } {
  return { x: (node.x / 100) * W, y: (node.y / 100) * H };
}

/**
 * Spatial system map. Positions are fixed by the model in percent of a 1000×560
 * frame, so the map scales with the stage without a layout engine or pan/zoom.
 */
export const ArchCanvas = memo(function ArchCanvas({ model, selectedId, onSelect }: { model: ArchModel; selectedId: string | null; onSelect: (id: string) => void }) {
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  return (
    <div className="arch-canvas">
      <div className="arch-frame">
        <svg className="arch-edges" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {model.edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const a = center(from);
            const b = center(to);
            const dx = (b.x - a.x) / 2;
            const horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
            const d = horizontal
              ? `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`
              : `M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}`;
            const lit = selectedId && (edge.from === selectedId || edge.to === selectedId);
            return (
              <g key={edge.id} className={`arch-edge prov-${edge.prov} tone-${edge.tone ?? "quiet"}${lit ? " is-lit" : ""}`}>
                <path d={d} vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        {model.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to || !edge.label) return null;
          return (
            <span key={`l-${edge.id}`} className="arch-edge-label" style={{ left: `${(from.x + to.x) / 2}%`, top: `${(from.y + to.y) / 2}%` }} title={`${edge.prov} · ${edge.source}`}>
              {edge.label}
            </span>
          );
        })}
        {model.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            className={`arch-node kind-${node.kind} tone-${node.tone ?? "quiet"} prov-${node.prov}${selectedId === node.id ? " is-selected" : ""}${node.touched?.length ? " is-touched" : ""}`}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
            aria-pressed={selectedId === node.id}
            title={`${node.label} · ${node.sub}`}
            aria-label={`${node.label}, ${node.sub}, ${node.prov}${node.touched?.length ? `, ${node.touched.length} changed files` : ""}`}
            onClick={() => onSelect(node.id)}
          >
            <span className="arch-node-label">{node.label}</span>
            <span className="arch-node-sub">{node.sub}</span>
            <span className="arch-node-foot">
              <span className={`prov-dot prov-${node.prov}`} aria-hidden="true" />
              {node.prov}
              {node.touched?.length ? <span className="touch-count">{node.touched.length} changed</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});
