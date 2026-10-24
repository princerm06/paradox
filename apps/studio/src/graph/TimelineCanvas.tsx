import { Background, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type NodeTypes } from "@xyflow/react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useWorkspace } from "../state/workspace.tsx";
import { generationNodeId, NODE_H, NODE_W, buildTimelineGraph, timelineGraphSignature, type StudioNode } from "./layout.ts";
import { GhostNode } from "./GhostNode.tsx";
import { TimelineNode } from "./TimelineNode.tsx";
import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = { timeline: TimelineNode, ghost: GhostNode };

function useTimelineGraph(): { nodes: StudioNode[]; edges: ReturnType<typeof buildTimelineGraph>["edges"] } {
  const { timelines, generations } = useWorkspace();
  const signature = timelineGraphSignature(timelines, generations);
  const cache = useRef<{ signature: string; graph: ReturnType<typeof buildTimelineGraph> } | null>(null);
  if (!cache.current || cache.current.signature !== signature) {
    cache.current = { signature, graph: buildTimelineGraph(timelines, generations) };
  }
  return cache.current.graph;
}

export function TimelineCanvas({
  expanded,
  onExpand,
  expandButtonRef,
}: {
  expanded: boolean;
  onExpand: () => void;
  expandButtonRef?: Ref<HTMLButtonElement>;
}) {
  const graph = useTimelineGraph();
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
    <div className="graph-host" ref={hostRef}>
      {ready ? (
        <ReactFlowProvider>
          <Flow nodes={graph.nodes} edges={graph.edges} expanded={expanded} onExpand={onExpand} expandButtonRef={expandButtonRef} />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}

function Flow({
  nodes,
  edges,
  expanded,
  onExpand,
  expandButtonRef,
}: {
  nodes: StudioNode[];
  edges: ReturnType<typeof buildTimelineGraph>["edges"];
  expanded: boolean;
  onExpand: () => void;
  expandButtonRef?: Ref<HTMLButtonElement>;
}) {
  const { fitView } = useReactFlow();
  const fitted = useRef(false);

  useEffect(() => {
    if (nodes.length === 0 || fitted.current) return;
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: expanded ? 0.22 : 0.16, duration: 0 });
      fitted.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, fitView, nodes.length]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.3}
      maxZoom={1.8}
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
      defaultEdgeOptions={{ type: "smoothstep", style: { stroke: "#465069", strokeWidth: 1.25 } }}
    >
      <Background color="#2a3142" gap={22} size={1} />
      <Panel position="top-left">
        <GraphTools expanded={expanded} onExpand={onExpand} expandButtonRef={expandButtonRef} />
      </Panel>
    </ReactFlow>
  );
}

function GraphTools({
  expanded,
  onExpand,
  expandButtonRef,
}: {
  expanded: boolean;
  onExpand: () => void;
  expandButtonRef?: Ref<HTMLButtonElement>;
}) {
  const { selectedId, selectedGenerationId } = useWorkspace();
  const focusId = selectedGenerationId ? generationNodeId(selectedGenerationId) : selectedId;
  const { fitView, zoomIn, zoomOut, getNode, setCenter } = useReactFlow();

  return (
    <div className="graph-tools" role="toolbar" aria-label="Timeline graph">
      <button type="button" className="btn" aria-label="Zoom out" onClick={() => void zoomOut({ duration: 160 })}>
        −
      </button>
      <button type="button" className="btn" aria-label="Zoom in" onClick={() => void zoomIn({ duration: 160 })}>
        +
      </button>
      <button type="button" className="btn" onClick={() => void fitView({ padding: 0.18, duration: 160 })}>
        Fit
      </button>
      <button
        type="button"
        className="btn"
        disabled={!focusId}
        onClick={() => {
          if (!focusId) return;
          const node = getNode(focusId);
          if (!node) return;
          const width = node.measured?.width ?? NODE_W;
          const height = node.measured?.height ?? NODE_H;
          void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: 1, duration: 160 });
        }}
      >
        Center
      </button>
      {expanded ? null : (
        <button ref={expandButtonRef} type="button" className="btn" onClick={onExpand}>
          Expand
        </button>
      )}
    </div>
  );
}
