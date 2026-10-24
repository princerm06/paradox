import type { Generation, Timeline } from "../api/types.ts";
import type { Subject } from "../shell/navigation.tsx";
import { ancestry, timelineById } from "../graph/tree.ts";

export type Origin = "root" | "ai" | "sprout" | "unrecorded";

export type Resolved = {
  subject: Subject;
  key: string;
  name: string;
  timeline: Timeline | null;
  /** Generation record id this subject has evidence under, if any. */
  generationId: string | null;
  generation: Generation | null;
  parent: Timeline | null;
  origin: Origin;
};

export function subjectKey(subject: Subject | null): string {
  return subject ? `${subject.kind}:${subject.id}` : "";
}

export function sameSubject(a: Subject | null, b: Subject | null): boolean {
  return subjectKey(a) === subjectKey(b);
}

export function timelineOrigin(timeline: Timeline): Origin {
  if (!timeline.parent_id) return "root";
  if (timeline.generation_id || timeline.modification === "ai") return "ai";
  if (timeline.modification === "popular_feed" || timeline.modification === "none") return "sprout";
  return "unrecorded";
}

export function resolveSubject(subject: Subject | null, timelines: Timeline[], generations: Generation[]): Resolved | null {
  if (!subject) return null;
  if (subject.kind === "timeline") {
    const timeline = timelineById(timelines, subject.id);
    if (!timeline) return null;
    const generation = timeline.generation_id ? generations.find((item) => item.id === timeline.generation_id) ?? null : null;
    return {
      subject,
      key: subjectKey(subject),
      name: timeline.name,
      timeline,
      generationId: timeline.generation_id,
      generation,
      parent: timelineById(timelines, timeline.parent_id),
      origin: timelineOrigin(timeline),
    };
  }
  const generation = generations.find((item) => item.id === subject.id) ?? null;
  if (!generation) return null;
  const produced = generation.timeline_id ? timelineById(timelines, generation.timeline_id) : null;
  return {
    subject,
    key: subjectKey(subject),
    name: generation.name,
    timeline: produced,
    generationId: generation.id,
    generation,
    parent: timelineById(timelines, generation.parent_id),
    origin: "ai",
  };
}

/** Generations that never produced a timeline still in the list (failed, cancelled, running, unknown). */
export function unlinkedGenerations(timelines: Timeline[], generations: Generation[]): Generation[] {
  return generations.filter((generation) => !timelines.some((timeline) => timeline.id === generation.timeline_id || timeline.generation_id === generation.id));
}

export type SubjectOption = { subject: Subject; label: string; detail: string; group: "Timelines" | "Attempts without a timeline" };

export function subjectOptions(timelines: Timeline[], generations: Generation[]): SubjectOption[] {
  const options: SubjectOption[] = timelines.map((timeline) => ({
    subject: { kind: "timeline", id: timeline.id },
    label: timeline.name,
    detail: [timeline.is_active ? "live" : null, timeline.parent_id ? timeline.status : "root"].filter(Boolean).join(" · "),
    group: "Timelines",
  }));
  for (const generation of unlinkedGenerations(timelines, generations)) {
    options.push({
      subject: { kind: "generation", id: generation.id },
      label: generation.name,
      detail: generation.status,
      group: "Attempts without a timeline",
    });
  }
  return options;
}

/** The timeline a subject hangs from in the tree (itself, or a ghost's parent). */
export function anchorTimelineId(resolved: Resolved): string | null {
  if (resolved.timeline) return resolved.timeline.id;
  return resolved.generation?.parent_id ?? null;
}

/** Plain-language lineage relation between two subjects, from parent_id links only. */
export function lineageRelation(a: Resolved, b: Resolved, timelines: Timeline[]): string {
  const aId = anchorTimelineId(a);
  const bId = anchorTimelineId(b);
  if (!aId || !bId) return "Lineage unavailable: a parent timeline is missing from the engine's list.";
  const aChain = ancestry(timelines, aId);
  const bChain = ancestry(timelines, bId);
  const aGhost = !a.timeline;
  const bGhost = !b.timeline;
  if (aId === bId && !aGhost && !bGhost) return "Same timeline.";
  if (aGhost && bGhost && aId === bId) return `Sibling attempts from ${timelineById(timelines, aId)?.name ?? "the same parent"}.`;
  if (!aGhost && bGhost && b.generation?.parent_id === aId) return `${b.name} was attempted directly from ${a.name}.`;
  if (aGhost && !bGhost && a.generation?.parent_id === bId) return `${a.name} was attempted directly from ${b.name}.`;
  if (!aGhost && bChain.some((item) => item.id === aId)) return `${b.name} descends from ${a.name} (${bChain.length - aChain.length} step${bChain.length - aChain.length === 1 ? "" : "s"}).`;
  if (!bGhost && aChain.some((item) => item.id === bId)) return `${a.name} descends from ${b.name} (${aChain.length - bChain.length} step${aChain.length - bChain.length === 1 ? "" : "s"}).`;
  let common: Timeline | null = null;
  for (let index = 0; index < Math.min(aChain.length, bChain.length); index += 1) {
    if (aChain[index].id !== bChain[index].id) break;
    common = aChain[index];
  }
  if (!common) return "No common ancestor in the engine's timeline list.";
  return `Diverge from ${common.name}.`;
}
