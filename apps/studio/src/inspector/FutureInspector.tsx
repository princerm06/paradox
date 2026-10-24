import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import type { Generation, GenerationCheck } from "../api/types.ts";
import { ancestry, timelineById } from "../graph/tree.ts";
import { formatRelative, formatStamp, generationStageLabel, isTerminalGeneration, modificationLabel, shortId, statusLabel } from "../lib/format.ts";
import { useWorkspace } from "../state/workspace.tsx";

const TABS = ["Overview", "Diff", "Logs", "Tests"] as const;
type Tab = (typeof TABS)[number];

type Inspection = {
  record: Generation;
  agent: string[];
  validation: string[];
  diff: string;
};

export function FutureInspector() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<Tab>("Overview");
  const ghost = workspace.generations.find((generation) => generation.id === workspace.selectedGenerationId) ?? null;
  const selected = ghost ? null : timelineById(workspace.timelines, workspace.selectedId);
  const generationId = ghost?.id ?? selected?.generation_id ?? null;
  const known = workspace.generations.find((generation) => generation.id === generationId) ?? ghost;
  const [cancelError, setCancelError] = useState<string | null>(null);
  const inspection = useInspection(generationId, known?.updated_at ?? "");
  const chain = ancestry(workspace.timelines, ghost ? ghost.parent_id : workspace.selectedId);
  const title = ghost ? ghost.name : selected ? selected.name : "Nothing selected";

  return (
    <aside className="panel inspector">
      <header className="panel-head">
        <p className="brand-kicker">Future inspector</p>
        <h2>{title}</h2>
        {ghost ? (
          <div className="identity">
            <span className={`pill ${ghost.status === "failed" ? "status-declined" : ghost.status === "pending" ? "status-pending" : ""}`}>{generationStageLabel(ghost)}</span>
            <span className="pill selected">Selected</span>
          </div>
        ) : selected ? (
          <div className="identity">
            <span className={`pill status-${selected.status}`}>{statusLabel(selected)}</span>
            {selected.is_active ? <span className="pill live">Live</span> : <span className="pill">Not live</span>}
            <span className="pill selected">Selected</span>
          </div>
        ) : (
          <p className="panel-note">Choose a timeline in the explorer.</p>
        )}
      </header>
      <div className="tabs" role="tablist" aria-label="Inspector">
        {TABS.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "tab is-on" : "tab"} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
        {!ghost && !selected ? <div className="empty"><p>Select a timeline to inspect it. Selection leaves the running application unchanged.</p></div> : null}
        {(ghost || selected) && tab === "Overview" ? <Overview /> : null}
        {(ghost || selected) && tab === "Diff" ? <DiffPanel inspection={inspection} hasGeneration={Boolean(generationId)} /> : null}
        {(ghost || selected) && tab === "Logs" ? <LogsPanel inspection={inspection} hasGeneration={Boolean(generationId)} /> : null}
        {(ghost || selected) && tab === "Tests" ? <TestsPanel inspection={inspection} hasGeneration={Boolean(generationId)} /> : null}
      </div>
      <footer className="panel-foot actions">
        {ghost && !isTerminalGeneration(ghost.status) ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              void workspace.cancelGeneration(ghost.id).catch((reason: unknown) => {
                setCancelError(reason instanceof ApiError ? reason.message : "The generation could not be cancelled.");
              });
            }}
          >
            Cancel generation
          </button>
        ) : (
          <div className="action-row">
            <button type="button" disabled>Enter</button>
            <button type="button" disabled>Confirm</button>
            <button type="button" disabled>Decline</button>
            <button type="button" disabled>Compare</button>
          </div>
        )}
        {cancelError ? <p className="inspector-error">{cancelError}</p> : null}
        <p className="foot-note">
          {ghost && !isTerminalGeneration(ghost.status)
            ? "Cancel stops this generation. It does not switch the running application."
            : "Enter, confirm, decline, and compare stay reserved. Selection does not activate a future."}
        </p>
        {chain.length > 0 ? (
          <p className="ancestry">
            {chain.map((timeline, index) => (
              <span key={timeline.id}>
                {index > 0 ? <span className="sep">/</span> : null}
                <button type="button" className="crumb" onClick={() => workspace.selectTimeline(timeline.id)}>
                  {timeline.name}
                </button>
              </span>
            ))}
            {ghost ? (
              <span>
                <span className="sep">/</span>
                {ghost.name}
              </span>
            ) : null}
          </p>
        ) : null}
      </footer>
    </aside>
  );
}

function Overview() {
  const { timelines, generations, selectedId, selectedGenerationId, selectTimeline } = useWorkspace();
  const ghost = generations.find((generation) => generation.id === selectedGenerationId) ?? null;
  const timeline = ghost ? null : timelineById(timelines, selectedId);
  const linked = ghost ?? (timeline?.generation_id ? generations.find((generation) => generation.id === timeline.generation_id) ?? null : null);
  const parent = timelineById(timelines, ghost ? ghost.parent_id : timeline?.parent_id ?? null);
  if (ghost) {
    return (
      <div className="overview">
        <dl>
          <div><dt>Status</dt><dd>{generationStageLabel(ghost)}</dd></div>
          <div><dt>Provider</dt><dd>{ghost.provider}</dd></div>
          <div><dt>Parent</dt><dd>{parent ? <button type="button" className="crumb" onClick={() => selectTimeline(parent.id)}>{parent.name}</button> : "Missing parent"}</dd></div>
          <div><dt>Started</dt><dd>{formatStamp(ghost.created_at)}<span>{formatRelative(ghost.created_at)}</span></dd></div>
          {ghost.finished_at ? <div><dt>Finished</dt><dd>{formatStamp(ghost.finished_at)}</dd></div> : null}
        </dl>
        {ghost.error?.message ? <p className="inspector-error">{ghost.error.message}</p> : null}
        <p className="prompt-block">{ghost.prompt}</p>
        <Technical generation={ghost} />
      </div>
    );
  }
  if (!timeline) return null;
  return (
    <div className="overview">
      <dl>
        <div><dt>Status</dt><dd>{timeline.status}</dd></div>
        <div><dt>Parent</dt><dd>{parent ? parent.name : timeline.parent_id ? "Missing parent" : "None"}</dd></div>
        <div><dt>Created</dt><dd>{formatStamp(timeline.created_at)}<span>{formatRelative(timeline.created_at)}</span></dd></div>
        <div><dt>Modification</dt><dd>{modificationLabel(timeline.modification)}</dd></div>
        <div><dt>Active</dt><dd>{timeline.is_active ? "Yes, serving the runtime" : "No"}</dd></div>
        {linked ? <div><dt>Generation</dt><dd>{generationStageLabel(linked)} · {linked.provider}</dd></div> : null}
      </dl>
      <h3>Ancestry</h3>
      <ol className="chain">
        {ancestry(timelines, timeline.id).map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => selectTimeline(item.id)} aria-current={item.id === timeline.id ? "true" : undefined}>
              {item.name}
            </button>
            <span>{item.is_active ? "Live" : statusLabel(item)}</span>
          </li>
        ))}
      </ol>
      <Technical generation={linked} timelineId={timeline.id} snapshotId={timeline.snapshot_id} generationId={timeline.generation_id} />
    </div>
  );
}

function Technical({
  generation,
  timelineId,
  snapshotId,
  generationId,
}: {
  generation: Generation | null;
  timelineId?: string;
  snapshotId?: string | null;
  generationId?: string | null;
}) {
  if (!generation && !timelineId) return null;
  return (
    <details className="more">
      <summary>Technical details</summary>
      <dl>
        {timelineId ? <div><dt>Timeline</dt><dd className="mono">{timelineId}</dd></div> : null}
        {snapshotId !== undefined ? <div><dt>Snapshot</dt><dd className="mono">{shortId(snapshotId)}</dd></div> : null}
        {generation ? <div><dt>Generation</dt><dd className="mono">{generation.id}</dd></div> : null}
        {!generation && generationId ? <div><dt>Generation</dt><dd className="mono">{generationId}</dd></div> : null}
        {generation?.base_snapshot_id ? <div><dt>Base snapshot</dt><dd className="mono">{shortId(generation.base_snapshot_id)}</dd></div> : null}
        {generation ? <div><dt>Activate on success</dt><dd>{generation.activate_on_success ? "On" : "Off"}</dd></div> : null}
        {generation ? <div><dt>Updated</dt><dd>{formatStamp(generation.updated_at)}</dd></div> : null}
      </dl>
    </details>
  );
}

function DiffPanel({ inspection, hasGeneration }: { inspection: InspectionState; hasGeneration: boolean }) {
  if (!hasGeneration) return <p className="deferred-copy">This future has no generation record.</p>;
  if (inspection.error) return <p className="inspector-error">{inspection.error}</p>;
  if (!inspection.packet) return <p className="deferred-copy">Loading the diff.</p>;
  if (!inspection.packet.diff.trim()) return <p className="deferred-copy">The engine returned an empty diff.</p>;
  return (
    <pre className="diff">
      {inspection.packet.diff.split("\n").map((line, index) => (
        <div key={index} className={diffClass(line)}>{line || " "}</div>
      ))}
    </pre>
  );
}

function LogsPanel({ inspection, hasGeneration }: { inspection: InspectionState; hasGeneration: boolean }) {
  if (!hasGeneration) return <p className="deferred-copy">This future has no generation record.</p>;
  if (inspection.error) return <p className="inspector-error">{inspection.error}</p>;
  if (!inspection.packet) return <p className="deferred-copy">Loading logs.</p>;
  return (
    <div className="logs">
      <LogBlock title="Agent" lines={inspection.packet.agent} />
      <LogBlock title="Validation" lines={inspection.packet.validation} />
    </div>
  );
}

function LogBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {lines.length === 0 ? <p className="deferred-copy">No {title.toLowerCase()} output yet.</p> : <pre className="log">{lines.join("\n")}</pre>}
    </section>
  );
}

function TestsPanel({ inspection, hasGeneration }: { inspection: InspectionState; hasGeneration: boolean }) {
  if (!hasGeneration) return <p className="deferred-copy">This future has no generation record.</p>;
  if (inspection.error) return <p className="inspector-error">{inspection.error}</p>;
  if (!inspection.packet) return <p className="deferred-copy">Loading validation.</p>;
  const evaluation = inspection.packet.record.evaluation;
  if (!evaluation) return <p className="deferred-copy">Validation has not reported checks yet.</p>;
  const checks = evaluation.checks ?? [];
  return (
    <div className="checks">
      {typeof evaluation.passed === "boolean" ? <p>{evaluation.passed ? "All reported checks passed." : "A reported check failed."}</p> : null}
      {checks.length === 0 ? <p className="deferred-copy">No checks were reported.</p> : checks.map((check) => <CheckRow key={check.name} check={check} />)}
      {evaluation.tests && (typeof evaluation.tests.passed === "number" || typeof evaluation.tests.failed === "number" || typeof evaluation.tests.errors === "number") ? (
        <p className="deferred-copy">
          Tests reported
          {typeof evaluation.tests.passed === "number" ? ` ${evaluation.tests.passed} passed` : ""}
          {typeof evaluation.tests.failed === "number" ? ` ${evaluation.tests.failed} failed` : ""}
          {typeof evaluation.tests.errors === "number" ? ` ${evaluation.tests.errors} errors` : ""}.
        </p>
      ) : null}
    </div>
  );
}

function CheckRow({ check }: { check: GenerationCheck }) {
  return (
    <div className={`check is-${check.status}`}>
      <span>{check.name}</span>
      <span>{check.status}</span>
      {typeof check.duration_ms === "number" ? <span>{check.duration_ms} ms</span> : null}
      {check.detail ? <span>{check.detail}</span> : null}
    </div>
  );
}

type InspectionState = { packet: Inspection | null; error: string | null };

function useInspection(generationId: string | null, updatedAt: string): InspectionState {
  const [packet, setPacket] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!generationId) {
      setPacket(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      api.generation(generationId),
      api.generationLogs(generationId, "agent"),
      api.generationLogs(generationId, "validation"),
      api.generationDiff(generationId),
    ]).then(
      ([record, agent, validation, diff]) => {
        if (cancelled) return;
        setPacket({ record, agent: agent.lines ?? [], validation: validation.lines ?? [], diff });
        setError(null);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof ApiError ? reason.message : "Generation details could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [generationId, updatedAt]);

  return { packet, error };
}

function diffClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}
