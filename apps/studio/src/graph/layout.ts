import { Position, type Edge, type Node } from "@xyflow/react";
import type { Generation, Timeline } from "../api/types.ts";
import { generationStageLabel, modificationLabel, statusLabel } from "../lib/format.ts";
import { isActiveGeneration } from "../lib/generation.ts";

export const NODE_W = 288;
export const NODE_H = 160;
const GAP_X = 116;
const GAP_Y = 52;

export function generationNodeId(id: string): string {
  return `generation:${id}`;
}

export type TimelineNodeData = {
  name: string;
  statusText: string;
  parentName: string | null;
  createdAt: string;
  modificationText: string | null;
  isActive: boolean;
  isPending: boolean;
  isConfirmed: boolean;
  isDeclined: boolean;
  isRoot: boolean;
  hasChildren: boolean;
};

export type GhostNodeData = {
  generationId: string;
  name: string;
  statusText: string;
  parentName: string | null;
  createdAt: string;
  provider: string;
  isRunning: boolean;
  isFailed: boolean;
  isCancelled: boolean;
  isSucceeded: boolean;
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
    positions.set(id, { x: spot.depth * (NODE_W + GAP_X), y: spot.column * (NODE_H + GAP_Y) });
  }
  return positions;
}

export function timelineGraphSignature(timelines: Timeline[], generations: Generation[] = []): string {
  const timelinesKey = timelines
    .map((timeline) => [timeline.id, timeline.parent_id ?? "", timeline.name, timeline.status, timeline.is_active ? "1" : "0", timeline.created_at, timeline.modification ?? ""].join("\t"))
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
  const nameById = new Map(timelines.map((timeline) => [timeline.id, timeline.name]));
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
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        name: timeline.name,
        statusText: statusText(timeline),
        parentName: timeline.parent_id ? nameById.get(timeline.parent_id) ?? null : null,
        createdAt: timeline.created_at,
        modificationText: timeline.modification ? modificationLabel(timeline.modification) : null,
        isActive: timeline.is_active,
        isPending: timeline.status === "pending",
        isConfirmed: timeline.status === "confirmed",
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
        type: "branch",
        data: { running: false },
      });
    }
  }
  for (const generation of generations) {
    const id = generationNodeId(generation.id);
    const position = positions.get(id);
    if (!position) continue;
    const running = isActiveGeneration(generation.status);
    nodes.push({
      id,
      type: "ghost",
      position,
      width: NODE_W,
      height: NODE_H,
      style: { pointerEvents: "all" },
      draggable: false,
      connectable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        generationId: generation.id,
        name: generation.name,
        statusText: generationStageLabel(generation),
        parentName: nameById.get(generation.parent_id) ?? null,
        createdAt: generation.created_at,
        provider: generation.provider,
        isRunning: running,
        isFailed: generation.status === "failed",
        isCancelled: generation.status === "cancelled",
        isSucceeded: generation.status === "succeeded",
      },
    });
    edges.push({
      id: `edge:${generation.parent_id}:${id}`,
      source: generation.parent_id,
      target: id,
      type: "branch",
      data: { running, ghost: true },
    });
  }
  return { nodes, edges };
}
