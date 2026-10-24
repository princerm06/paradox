import type { Timeline } from "../api/types.ts";

function byCreated(a: Timeline, b: Timeline): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export function timelineById(timelines: Timeline[], id: string | null): Timeline | null {
  if (!id) return null;
  return timelines.find((timeline) => timeline.id === id) ?? null;
}

export function childTimelines(timelines: Timeline[], parentId: string): Timeline[] {
  return timelines.filter((timeline) => timeline.parent_id === parentId).sort(byCreated);
}

export function rootTimelines(timelines: Timeline[]): Timeline[] {
  const ids = new Set(timelines.map((timeline) => timeline.id));
  return timelines
    .filter((timeline) => !timeline.parent_id || !ids.has(timeline.parent_id))
    .sort(byCreated);
}

export function ancestry(timelines: Timeline[], id: string | null): Timeline[] {
  const chain: Timeline[] = [];
  const seen = new Set<string>();
  let current = timelineById(timelines, id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent_id ? timelineById(timelines, current.parent_id) : null;
  }
  return chain;
}
