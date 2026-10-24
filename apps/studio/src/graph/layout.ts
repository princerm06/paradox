import { Position, type Edge, type Node } from "@xyflow/react";
import type { Generation, Timeline } from "../api/types.ts";
import { generationStageLabel, isTerminalGeneration, statusLabel } from "../lib/format.ts";

export const NODE_W = 220;
export const NODE_H = 64;
const GAP_X = 52;
const GAP_Y = 64;

export function generationNodeId(id: string): string {
  return `generation:${id}`;
}

export type TimelineNodeData = {
  name: string;
  statusText: string;
  isActive: boolean;
  isPending: boolean;
  isDeclined: boolean;
  isRoot: boolean;
  hasChildren: boolean;
};

export type GhostNodeData = {
  generationId: string;
  name: string;
  statusText: string;
  isRunning: boolean;
  isFailed: boolean;
  isCancelled: boolean;
};

export type TimelineFlowNode = Node<TimelineNodeData, "timeline">;
export type GhostFlowNode = Node<GhostNodeData, "ghost">;
export type StudioNode = TimelineFlowNode | GhostFlowNode;

type GraphItem = {
  id: string;
  parentId: string | null;
  createdAt: string;
  sortId: string;
};

function showGhost(generation: Generation, timelines: Timeline[]): boolean {
  return !timelines.some((timeline) => timeline.id === generation.timeline_id || timeline.generation_id === generation.id);
}

type Spot = { column: number; depth: number };

function statusText(timeline: Timeline): string {
  return statusLabel(timeline);
}

function graphItems(timelines: Timeline[], generations: Generation[] = []): GraphItem[] {
  const ids = new Set(timelines.map((timeline) => timeline.id));
  const items: GraphItem[] = timelines.map((timeline) => ({
    id: timeline.id,
    parentId: timeline.parent_id && ids.has(timeline.parent_id) ? timeline.parent_id : null,
    createdAt: timeline.created_at,
    sortId: timeline.id,
  }));
  for (const generation of generations) {
    if (!showGhost(generation, timelines) || !ids.has(generation.parent_id)) continue;
    items.push({
      id: generationNodeId(generation.id),
      parentId: generation.parent_id,
      createdAt: generation.created_at,
      sortId: generation.id,
    });
  }
  return items;
}

function childrenOf(items: GraphItem[], parentId: string | null): GraphItem[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sortId.localeCompare(b.sortId));
}

function place(id: string, depth: number, start: number, items: GraphItem[], placed: Map<string, Spot>, seen: Set<string>): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const kids = childrenOf(items, id);
  if (kids.length === 0) {
    placed.set(id, { column: start, depth });
    return 1;
  }
  let used = 0;
  for (const kid of kids) used += place(kid.id, depth + 1, start + used, items, placed, seen);
  const first = placed.get(kids[0].id);
  const last = placed.get(kids[kids.length - 1].id);
  placed.set(id, { column: first && last ? (first.column + last.column) / 2 : start, depth });
  return used || 1;
}

function layoutPositions(items: GraphItem[]): Map<string, { x: number; y: number }> {
  const placed = new Map<string, Spot>();
  const seen = new Set<string>();
  let cursor = 0;
  for (const root of childrenOf(items, null)) cursor += place(root.id, 0, cursor, items, placed, seen);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, spot] of placed) {
    positions.set(id, { x: spot.column * (NODE_W + GAP_X), y: spot.depth * (NODE_H + GAP_Y) });
  }
  return positions;
}

export function timelineGraphSignature(timelines: Timeline[], generations: Generation[] = []): string {
  const timelinesKey = timelines
    .map((timeline) => [timeline.id, timeline.parent_id ?? "", timeline.name, timeline.status, timeline.is_active ? "1" : "0", timeline.created_at].join("\t"))
    .sort()
    .join("\n");
  const generationsKey = generations
    .map((generation) => [generation.id, generation.parent_id, generation.name, generation.status, generation.timeline_id ?? "", generation.error?.stage ?? ""].join("\t"))
    .sort()
    .join("\n");
  return `${timelinesKey}\n--\n${generationsKey}`;
}

export function buildTimelineGraph(timelines: Timeline[], generations: Generation[] = []): { nodes: StudioNode[]; edges: Edge[] } {
  const items = graphItems(timelines, generations);
  const positions = layoutPositions(items);
  const childIds = new Set(items.filter((item) => item.parentId).map((item) => item.parentId));
  const nodes: StudioNode[] = [];
  const edges: Edge[] = [];
  for (const timeline of timelines) {
    const position = positions.get(timeline.id);
    if (!position) continue;
    nodes.push({
      id: timeline.id,
      type: "timeline",
      position,
      width: NODE_W,
      height: NODE_H,
      style: { pointerEvents: "all" },
      draggable: false,
      connectable: false,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        name: timeline.name,
        statusText: statusText(timeline),
        isActive: timeline.is_active,
        isPending: timeline.status === "pending",
        isDeclined: timeline.status === "declined",
        isRoot: !timeline.parent_id,
        hasChildren: childIds.has(timeline.id),
      },
    });
    if (timeline.parent_id && positions.has(timeline.parent_id)) {
      edges.push({
        id: `edge:${timeline.parent_id}:${timeline.id}`,
        source: timeline.parent_id,
        target: timeline.id,
        type: "smoothstep",
      });
    }
  }
  for (const generation of generations) {
    const id = generationNodeId(generation.id);
    const position = positions.get(id);
    if (!position) continue;
    const running = !isTerminalGeneration(generation.status);
    nodes.push({
      id,
      type: "ghost",
      position,
      width: NODE_W,
      height: NODE_H,
      style: { pointerEvents: "all" },
      draggable: false,
      connectable: false,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        generationId: generation.id,
        name: generation.name,
        statusText: generationStageLabel(generation),
        isRunning: running,
        isFailed: generation.status === "failed",
        isCancelled: generation.status === "cancelled",
      },
    });
    edges.push({
      id: `edge:${generation.parent_id}:${id}`,
      source: generation.parent_id,
      target: id,
      type: "smoothstep",
      style: { stroke: "#6d628f", strokeDasharray: "4 4" },
    });
  }
  return { nodes, edges };
}
