import { memo, useEffect, useRef, useState } from "react";
import type { ArchModel, ArchNode } from "./model.ts";

export function ComponentIcon({ kind }: { kind: ArchNode["kind"] }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "store" ? <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></> :
        kind === "check" ? <><path d="m12 3-7 3v5c0 4.7 3 8 7 10 4-2 7-5.3 7-10V6l-7-3Z" /><path d="m8 12 3 3 5-6" /></> :
        kind === "worker" || kind === "provider" ? <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /></> :
        kind === "client" ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4M3 8h18" /></> :
        kind === "seam" || kind === "file" ? <path d="m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12" /> :
        <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></>}
    </svg>
  );
}

const W = 1000;
const H = 560;

function center(node: ArchNode): { x: number; y: number } {
  return { x: (node.x / 100) * W, y: (node.y / 100) * H };
}

export const ArchCanvas = memo(function ArchCanvas({ model, selectedId, onSelect }: { model: ArchModel; selectedId: string | null; onSelect: (id: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame = 0;
    let width = 0;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setZoom(Math.min(1, Math.max(0.75, width / 1200))));
    });
    observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  return (
    <>
      <div className="arch-map-tools" role="group" aria-label="Architecture map controls">
        <span>Scroll to explore · select a component</span>
        <button type="button" className="text-btn" aria-label="Zoom architecture out" disabled={zoom <= 0.35} onClick={() => setZoom((value) => Math.max(0.35, value - 0.1))}>−</button>
        <output aria-label="Architecture zoom">{Math.round(zoom * 100)}%</output>
        <button type="button" className="text-btn" aria-label="Zoom architecture in" disabled={zoom >= 1.5} onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}>+</button>
        <button type="button" className="text-btn" onClick={() => {
          const element = viewport.current;
          if (!element) return;
          setZoom(Math.min(1, Math.max(0.35, Math.min(element.clientWidth / 1200, element.clientHeight / 840))));
          element.scrollTo?.({ left: 0, top: 0 });
        }}>Fit map</button>
      </div>
      <div className="arch-canvas" ref={viewport} tabIndex={0} role="region" aria-label="Scrollable system graph">
      <div className="arch-world" style={{ width: 1200 * zoom, height: 840 * zoom }}>
      <div className="arch-frame" style={{ transform: `scale(${zoom})` }}>
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
            <span key={`l-${edge.id}`} className={`arch-edge-label${selectedId && (edge.from === selectedId || edge.to === selectedId) ? " is-lit" : ""}`} style={{ left: `${(from.x + to.x) / 2}%`, top: `${(from.y + to.y) / 2}%` }} title={`${edge.prov} · ${edge.source}`}>
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
            <span className="arch-node-top"><span className="arch-component-icon"><ComponentIcon kind={node.kind} /></span><span className="arch-node-kind">{node.kind}</span></span>
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
    </div>
    </>
  );
});
