import { useMemo } from "react";
import type { Generation, Timeline } from "../api/types.ts";
import { generationStageLabel, statusLabel } from "../lib/format.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { childTimelines, rootTimelines } from "./tree.ts";

type BranchRow = {
  key: string;
  depth: number;
  name: string;
  status: string;
  live: boolean;
  selected: boolean;
  failed: boolean;
  ghost: boolean;
  onSelect: () => void;
};

function visibleGhosts(generations: Generation[], timelines: Timeline[], parentId: string): Generation[] {
  return generations
    .filter((generation) => generation.parent_id === parentId && !timelines.some((timeline) => timeline.id === generation.timeline_id || timeline.generation_id === generation.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function BranchNavigator() {
  const { timelines, generations, selectedId, selectedGenerationId, selectTimeline, selectGeneration } = useWorkspace();
  const rows = useMemo(() => {
    const next: BranchRow[] = [];
    const visit = (timeline: Timeline, depth: number) => {
      next.push({
        key: timeline.id,
        depth,
        name: timeline.name,
        status: statusLabel(timeline),
        live: timeline.is_active,
        selected: selectedGenerationId === null && selectedId === timeline.id,
        failed: timeline.status === "declined",
        ghost: false,
        onSelect: () => selectTimeline(timeline.id),
      });
      const branches = [
        ...childTimelines(timelines, timeline.id).map((child) => ({ at: child.created_at, id: child.id, timeline: child, generation: null as Generation | null })),
        ...visibleGhosts(generations, timelines, timeline.id).map((generation) => ({ at: generation.created_at, id: generation.id, timeline: null as Timeline | null, generation })),
      ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      for (const branch of branches) {
        if (branch.timeline) visit(branch.timeline, depth + 1);
        else if (branch.generation) {
          const generation = branch.generation;
          next.push({
            key: `generation:${generation.id}`,
            depth: depth + 1,
            name: generation.name,
            status: generationStageLabel(generation),
            live: false,
            selected: selectedGenerationId === generation.id,
            failed: generation.status === "failed",
            ghost: true,
            onSelect: () => selectGeneration(generation.id),
          });
        }
      }
    };
    for (const root of rootTimelines(timelines)) visit(root, 0);
    return next;
  }, [generations, selectGeneration, selectTimeline, selectedGenerationId, selectedId, timelines]);

  return (
    <div className="branch-nav">
      <div className="branch-nav-head">
        <p>Futures</p>
      </div>
      <ol>
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              className={[
                "branch-row",
                row.selected ? "is-selected" : "",
                row.live ? "is-live" : "",
                row.ghost ? "is-ghost" : "",
                row.failed ? "is-failed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ paddingLeft: 10 + row.depth * 14 }}
              aria-pressed={row.selected}
              onClick={row.onSelect}
            >
              <span className="branch-mark" aria-hidden="true" />
              <span className="branch-copy">
                <span className="row-name">
                  {row.name}
                  {row.live ? <span className="live-pill">Live</span> : null}
                </span>
                <span className="row-meta">{row.status}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
