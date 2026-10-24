import { Background, MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow, useUpdateNodeInternals, type Edge, type NodeTypes, type ReactFlowInstance } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useWorkspace } from "../state/workspace.tsx";
import { ancestry } from "./tree.ts";
import { BranchEdge, type BranchEdgeData } from "./BranchEdge.tsx";
import { generationNodeId, NODE_H, NODE_W, buildTimelineGraph, timelineGraphSignature, type StudioNode } from "./layout.ts";
import { GhostNode } from "./GhostNode.tsx";
import { TimelineNode } from "./TimelineNode.tsx";
import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = { timeline: TimelineNode, ghost: GhostNode };
const edgeTypes = { branch: BranchEdge };

function useTimelineGraph(): { nodes: StudioNode[]; edges: ReturnType<typeof buildTimelineGraph>["edges"] } {
  const { timelines, generations } = useWorkspace();
  const signature = timelineGraphSignature(timelines, generations);
  const cache = useRef<{ signature: string; graph: ReturnType<typeof buildTimelineGraph> } | null>(null);
  if (!cache.current || cache.current.signature !== signature) {
    cache.current = { signature, graph: buildTimelineGraph(timelines, generations) };
  }
  return cache.current.graph;
}

type Box = { x: number; y: number; width: number; height: number };
type ZoomRange = { min: number; max: number };

const FRAME_GAP = 28;
const FOCUS_ZOOM: ZoomRange = { min: 0.68, max: 1.15 };
const FIT_ZOOM: ZoomRange = { min: 0.45, max: 1.15 };
const SIBLING_ZOOM_FLOOR = 0.8;
const MAX_SIBLINGS = 2;

function freeArea(host: HTMLElement): Box {
  const bounds = host.getBoundingClientRect();
  const stage = host.parentElement;
  const rectOf = (selector: string) => stage?.querySelector(selector)?.getBoundingClientRect() ?? null;
  let left = FRAME_GAP;
  let top = FRAME_GAP;
  let right = bounds.width - FRAME_GAP;
  let bottom = bounds.height - FRAME_GAP;
  const futures = rectOf(".futures-float");
  if (futures) left = Math.max(left, futures.right - bounds.left + FRAME_GAP);
  const header = rectOf(".explore-head");
  if (header) top = Math.max(top, header.bottom - bounds.top + FRAME_GAP / 2);
  for (const side of [rectOf(".portal-float"), rectOf(".inspector-float")]) {
    if (side) right = Math.min(right, side.left - bounds.left - FRAME_GAP);
  }
  for (const below of [rectOf(".composer-dock"), rectOf(".canvas-dock")]) {
    if (below) bottom = Math.min(bottom, below.top - bounds.top - FRAME_GAP / 2);
  }
  if (right - left < 240) {
    left = FRAME_GAP;
    right = bounds.width - FRAME_GAP;
  }
  if (bottom - top < 200) {
    top = FRAME_GAP;
    bottom = bounds.height - FRAME_GAP;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function nodeBox(flow: ReactFlowInstance, id: string): Box | null {
  const node = flow.getNode(id);
  if (!node) return null;
  return { x: node.position.x, y: node.position.y, width: node.measured?.width ?? NODE_W, height: node.measured?.height ?? NODE_H };
}

type Neighborhood = { core: string[]; siblings: string[] };

function neighborhood(focusId: string, edges: Edge[]): Neighborhood {
  const parentId = edges.find((edge) => edge.target === focusId)?.source ?? null;
  const children = edges.filter((edge) => edge.source === focusId).map((edge) => edge.target);
  const siblings = parentId ? edges.filter((edge) => edge.source === parentId && edge.target !== focusId).map((edge) => edge.target) : [];
  return { core: [focusId, ...(parentId ? [parentId] : []), ...children], siblings };
}

function union(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function fitZoom(bounds: Box, area: Box, range: ZoomRange): number {
  return Math.min(range.max, Math.max(range.min, Math.min(area.width / bounds.width, area.height / bounds.height)));
}

function frameBoxes(
  flow: ReactFlowInstance,
  host: HTMLElement,
  ids: string[],
  keepId: string | null,
  zoomRange: ZoomRange,
  duration: number,
  optional: string[] = [],
): Promise<boolean> | null {
  const boxes = ids.map((id) => nodeBox(flow, id)).filter((box): box is Box => box !== null);
  if (boxes.length === 0) return null;
  const area = freeArea(host);
  const keep = keepId ? nodeBox(flow, keepId) : null;
  let bounds = union(boxes);
  let zoom = fitZoom(bounds, area, zoomRange);
  if (keep) {
    const nearest = optional
      .map((id) => nodeBox(flow, id))
      .filter((box): box is Box => box !== null)
      .sort((a, b) => Math.abs(a.y - keep.y) - Math.abs(b.y - keep.y))
      .slice(0, MAX_SIBLINGS);
    for (const box of nearest) {
      const wider = union([bounds, box]);
      const widerZoom = fitZoom(wider, area, zoomRange);
      if (widerZoom < Math.min(zoom, SIBLING_ZOOM_FLOOR) || wider.width * widerZoom > area.width || wider.height * widerZoom > area.height) break;
      bounds = wider;
      zoom = widerZoom;
    }
  }
  const overflowsX = bounds.width * zoom > area.width;
  let x = overflowsX ? area.x - bounds.x * zoom : area.x + area.width / 2 - (bounds.x + bounds.width / 2) * zoom;
  let y = area.y + area.height / 2 - (bounds.y + bounds.height / 2) * zoom;
  if (keep) {
    const left = keep.x * zoom + x;
    const right = (keep.x + keep.width) * zoom + x;
    const top = keep.y * zoom + y;
    const bottom = (keep.y + keep.height) * zoom + y;
    if (right > area.x + area.width) x -= right - (area.x + area.width);
    if (left < area.x) x += area.x - left;
    if (bottom > area.y + area.height) y -= bottom - (area.y + area.height);
    if (top < area.y) y += area.y - top;
  }
  return flow.setViewport({ x, y, zoom }, { duration });
}

function frameFocus(flow: ReactFlowInstance, host: HTMLElement, focusId: string, edges: Edge[], duration: number): Promise<boolean> | null {
  const { core, siblings } = neighborhood(focusId, edges);
  return frameBoxes(flow, host, core, focusId, FOCUS_ZOOM, duration, siblings);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TimelineCanvas({ insetLeft = false, layoutKey = "" }: { insetLeft?: boolean; layoutKey?: string }) {
  const graph = useTimelineGraph();
  const edges = useBranchEdges(graph.edges);
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setReady(host.clientWidth > 0 && host.clientHeight > 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    const frame = window.requestAnimationFrame(update);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={insetLeft ? "graph-host is-stage canvas-inset" : "graph-host is-stage"} ref={hostRef}>
      {ready ? (
        <ReactFlowProvider>
          <Flow nodes={graph.nodes} edges={edges} hostRef={hostRef} layoutKey={layoutKey} />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}

function useBranchEdges(edges: Edge<BranchEdgeData>[]): Edge<BranchEdgeData>[] {
  const { timelines, selectedId, selectedGenerationId, activeTimelineId } = useWorkspace();
  return useMemo(() => {
    const parentId = selectedGenerationId
      ? edges.find((edge) => edge.target === generationNodeId(selectedGenerationId))?.source ?? null
      : selectedId;
    const selectedChain = new Set(ancestry(timelines, parentId).map((timeline) => timeline.id));
    const liveChain = new Set(ancestry(timelines, activeTimelineId).map((timeline) => timeline.id));
    return edges.map((edge) => {
      const ghostSelected = Boolean(selectedGenerationId && edge.target === generationNodeId(selectedGenerationId));
      const onLive = liveChain.has(edge.source) && liveChain.has(edge.target);
      const onSelected = selectedChain.has(edge.source) && (selectedChain.has(edge.target) || ghostSelected);
      const tone = onLive && !ghostSelected ? "live" : onSelected || ghostSelected ? "selected" : "quiet";
      // Lit paths paint over quiet siblings, including the bead they share at a
      // common parent port. Kept at or below zero so cards still occlude edges.
      const zIndex = tone === "live" ? 0 : tone === "selected" ? -1 : -2;
      return { ...edge, zIndex, data: { ...edge.data, tone } };
    });
  }, [activeTimelineId, edges, selectedGenerationId, selectedId, timelines]);
}

function Flow({
  nodes,
  edges,
  hostRef,
  layoutKey,
}: {
  nodes: StudioNode[];
  edges: Edge<BranchEdgeData>[];
  hostRef: RefObject<HTMLDivElement | null>;
  layoutKey: string;
}) {
  const { selectedId, selectedGenerationId, activeTimelineId } = useWorkspace();
  const updateNodeInternals = useUpdateNodeInternals();
  const flow = useReactFlow();
  const updateRef = useRef(updateNodeInternals);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const flowRef = useRef(flow);
  const focused = useRef<string | null>(null);
  updateRef.current = updateNodeInternals;
  nodesRef.current = nodes;
  edgesRef.current = edges;
  flowRef.current = flow;
  const nodeKey = nodes.map((node) => node.id).join("|");
  const focusId = selectedGenerationId ? generationNodeId(selectedGenerationId) : selectedId ?? activeTimelineId;
  const frameKey = focusId ? `${focusId}#${layoutKey}` : null;

  const measure = () => {
    for (const node of nodesRef.current) updateRef.current(node.id);
  };

  useEffect(() => {
    if (!nodeKey) return;
    const first = window.setTimeout(measure, 80);
    const second = window.setTimeout(measure, 220);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [nodeKey]);

  useEffect(() => {
    if (!focusId || !frameKey || focused.current === frameKey) return;
    let cancelled = false;
    let attempts = 0;
    const attempt = () => {
      if (cancelled || focused.current === frameKey) return;
      const host = hostRef.current;
      const framing = host && flowRef.current.getNode(focusId)
        ? frameFocus(flowRef.current, host, focusId, edgesRef.current, prefersReducedMotion() ? 0 : 280)
        : null;
      if (!framing) {
        if (attempts < 20) {
          attempts += 1;
          window.setTimeout(attempt, 50);
        }
        return;
      }
      void framing.then((moved) => {
        if (cancelled) return;
        if (moved) {
          focused.current = frameKey;
          return;
        }
        if (attempts < 20) {
          attempts += 1;
          window.setTimeout(attempt, 50);
        }
      });
    };
    const timer = window.setTimeout(attempt, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [focusId, frameKey, hostRef, nodeKey]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={0.45}
      maxZoom={1.35}
      defaultViewport={{ x: 80, y: 80, zoom: 1 }}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesReconnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      panOnScroll={false}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: false }}
      attributionPosition="bottom-left"
      defaultEdgeOptions={{ type: "branch" }}
    >
      <Background color="#243044" gap={28} size={1} />
      <MiniMap
        pannable
        zoomable
        position="bottom-left"
        bgColor="#10141c"
        maskColor="rgba(6, 8, 14, 0.72)"
        nodeStrokeWidth={2}
        style={{ width: 148, height: 92 }}
        ariaLabel="Timeline overview"
      />
      <Panel position="bottom-left" className="canvas-dock">
        <GraphTools focusId={focusId} hostRef={hostRef} edges={edges} />
      </Panel>
    </ReactFlow>
  );
}

function GraphTools({ focusId, hostRef, edges }: { focusId: string | null; hostRef: RefObject<HTMLDivElement | null>; edges: Edge[] }) {
  const flow = useReactFlow();
  const { zoomIn, zoomOut } = flow;

  return (
    <div className="graph-tools" role="toolbar" aria-label="Timeline graph">
      <button type="button" className="btn" aria-label="Zoom out" onClick={() => void zoomOut({ duration: 160 })}>
        −
      </button>
      <button type="button" className="btn" aria-label="Zoom in" onClick={() => void zoomIn({ duration: 160 })}>
        +
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (!hostRef.current) return;
          const ids = flow.getNodes().map((node) => node.id);
          void frameBoxes(flow, hostRef.current, ids, null, FIT_ZOOM, 160);
        }}
      >
        Fit
      </button>
      <button
        type="button"
        className="btn"
        disabled={!focusId}
        onClick={() => {
          if (!focusId || !hostRef.current) return;
          void frameFocus(flow, hostRef.current, focusId, edges, 160);
        }}
      >
        Center
      </button>
    </div>
  );
}
