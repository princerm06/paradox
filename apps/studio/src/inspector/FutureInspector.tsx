import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { errorMessage } from "../api/client.ts";
import type { Generation, Snapshot, Timeline } from "../api/types.ts";
import {
  ChecksView,
  DiffView,
  LoadingLine,
  LogLines,
  Notice,
  Provenance,
  ReportedFiles,
  diffProvenance,
} from "../evidence/EvidenceViews.tsx";
import { ancestry, timelineById } from "../graph/tree.ts";
import { useGenerationDiff, useGenerationLogs, useGenerationRecord, useSnapshots } from "../hooks/evidence.ts";
import { useTick } from "../hooks/useTick.ts";
import { reportedFiles } from "../lib/diff.ts";
import { formatRelative, formatStamp, generationStageLabel, modificationLabel, shortId, statusLabel } from "../lib/format.ts";
import { generationPhase, lifecycleSteps } from "../lib/generation.ts";
import { timelineOrigin } from "../lib/subject.ts";
import { useNavigation } from "../shell/navigation.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { TimelineActions, useRuntimeAction } from "./RuntimeActions.tsx";

const TABS = ["Overview", "Diff", "Logs", "Tests", "Snapshots"] as const;
type Tab = (typeof TABS)[number];

export function FutureInspector({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<Tab>("Overview");
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const ghost = workspace.generations.find((generation) => generation.id === workspace.selectedGenerationId) ?? null;
  const selected = ghost ? null : timelineById(workspace.timelines, workspace.selectedId);
  const generationId = ghost?.id ?? selected?.generation_id ?? null;
  const known = workspace.generations.find((generation) => generation.id === generationId) ?? null;
  const record = useGenerationRecord(generationId, known);
  const title = ghost ? ghost.name : selected ? selected.name : "Nothing selected";
  const tabs = TABS.filter((name) => name !== "Snapshots" || Boolean(selected));
  const current = tabs.includes(tab) ? tab : "Overview";

  if (!open) return null;

  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside className="inspector-float glass-panel" aria-label="Future inspector">
      <header className="inspector-head">
        <div className="inspector-title">
          <p className="brand-kicker">Future inspector</p>
          <button type="button" className="text-btn" onClick={onToggle} aria-label="Hide inspector">
            Hide
          </button>
        </div>
        <h2 title={title}>{title}</h2>
        <Identity ghost={ghost} timeline={selected} />
      </header>
      <div className="tabs" role="tablist" aria-label="Inspector sections">
        {tabs.map((name, index) => (
          <button
            key={name}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`${baseId}-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={current === name}
            aria-controls={`${baseId}-panel`}
            tabIndex={current === name ? 0 : -1}
            className={current === name ? "tab is-on" : "tab"}
            onClick={() => setTab(name)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${current}`} tabIndex={0}>
        {!ghost && !selected ? (
          <div className="empty">
            <p>Select a future on the canvas to inspect it. Selecting never changes the running application.</p>
          </div>
        ) : null}
        {ghost || selected ? (
          <>
            {current === "Overview" ? <Overview ghost={ghost} timeline={selected} generation={record.record} recordError={record.error} onTab={setTab} /> : null}
            {current === "Diff" ? <DiffPanel timeline={selected} generation={record.record} generationId={generationId} recordError={record.error} /> : null}
            {current === "Logs" ? <LogsPanel generation={record.record} generationId={generationId} /> : null}
            {current === "Tests" ? <TestsPanel generation={record.record} generationId={generationId} recordStatus={record.status} recordError={record.error} onTab={setTab} /> : null}
            {current === "Snapshots" && selected ? <SnapshotsPanel timeline={selected} /> : null}
          </>
        ) : null}
      </div>
      <footer className="inspector-foot">
        {selected ? <TimelineActions timeline={selected} /> : null}
        {ghost ? <GhostActions generation={ghost} /> : null}
        <Ancestry ghost={ghost} />
      </footer>
    </aside>
  );
}

function Identity({ ghost, timeline }: { ghost: Generation | null; timeline: Timeline | null }) {
  if (ghost) {
    const phase = generationPhase(ghost.status);
    return (
      <div className="identity">
        <span className={`pill phase-${phase}`}>{generationStageLabel(ghost)}</span>
        <span className="pill">Attempt · no timeline{phase === "succeeded" ? " on record" : ""}</span>
        <span className="pill selected">Selected</span>
      </div>
    );
  }
  if (!timeline) return null;
  return (
    <div className="identity">
      <span className={`pill status-${timeline.parent_id ? timeline.status : "root"}`}>{statusLabel(timeline)}</span>
      {timeline.is_active ? <span className="pill live">Live</span> : <span className="pill">Not live</span>}
      <span className="pill selected">Selected</span>
    </div>
  );
}

function originText(timeline: Timeline, generation: Generation | null): string {
  const origin = timelineOrigin(timeline);
  if (origin === "root") return "Root codebase";
  if (origin === "ai") return generation ? `AI generation · ${generation.provider}` : "AI generation";
  if (origin === "sprout") return `Engine sprout · ${modificationLabel(timeline.modification)}`;
  return "Origin not recorded";
}

function Overview({
  ghost,
  timeline,
  generation,
  recordError,
  onTab,
}: {
  ghost: Generation | null;
  timeline: Timeline | null;
  generation: Generation | null;
  recordError: string | null;
  onTab: (tab: Tab) => void;
}) {
  const { timelines, selectTimeline } = useWorkspace();
  const navigation = useNavigation();
  const parent = timelineById(timelines, ghost ? ghost.parent_id : timeline?.parent_id ?? null);
  const files = reportedFiles(generation);

  if (ghost) {
    const phase = generationPhase(ghost.status);
    return (
      <div className="overview">
        {phase === "active" || phase === "failed" || phase === "cancelled" ? <Stepper generation={ghost} /> : null}
        {phase === "unknown" ? (
          <Notice tone="warn">The engine reported status "{ghost.status}", which this studio does not recognise. It is not shown as running and cannot be cancelled here.</Notice>
        ) : null}
        {ghost.error?.message ? (
          <Notice tone="error">
            <strong>{ghost.error.stage ? `Stopped at ${ghost.error.stage}` : "Stopped"}</strong> · {ghost.error.message}
          </Notice>
        ) : null}
        <dl className="facts">
          <div>
            <dt>Provider</dt>
            <dd>{ghost.provider}</dd>
          </div>
          <div>
            <dt>Parent</dt>
            <dd>
              {parent ? (
                <button type="button" className="crumb" onClick={() => selectTimeline(parent.id)}>
                  {parent.name}
                </button>
              ) : (
                "Missing from timeline list"
              )}
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              {formatStamp(ghost.created_at)} <span className="fine">{formatRelative(ghost.created_at)}</span>
            </dd>
          </div>
          {ghost.finished_at ? (
            <div>
              <dt>Finished</dt>
              <dd>{formatStamp(ghost.finished_at)}</dd>
            </div>
          ) : null}
          <div>
            <dt>On success</dt>
            <dd>{ghost.activate_on_success ? <span className="warn-text">Becomes live automatically</span> : "Stays inactive until you make it live"}</dd>
          </div>
        </dl>
        <PromptBlock prompt={ghost.prompt} />
        {files.length ? (
          <section>
            <h3>
              Files the agent changed <Provenance kind="observed" source="generation.changes" />
            </h3>
            <ReportedFiles files={files} onPick={() => onTab("Diff")} />
          </section>
        ) : null}
        <LinkRow
          onCompare={() => navigation.compare({ kind: "generation", id: ghost.id })}
          onArchitect={() => navigation.architect({ kind: "generation", id: ghost.id })}
        />
        <Technical rows={[["Generation", ghost.id], ["Base snapshot", ghost.base_snapshot_id ?? "Not assigned yet"], ["Updated", formatStamp(ghost.updated_at)]]} />
      </div>
    );
  }
  if (!timeline) return null;
  return (
    <div className="overview">
      <dl className="facts">
        <div>
          <dt>Origin</dt>
          <dd>{originText(timeline, generation)}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>
            {parent ? (
              <button type="button" className="crumb" onClick={() => selectTimeline(parent.id)}>
                {parent.name}
              </button>
            ) : timeline.parent_id ? (
              "Missing from timeline list"
            ) : (
              "None"
            )}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {formatStamp(timeline.created_at)} <span className="fine">{formatRelative(timeline.created_at)}</span>
          </dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{timeline.is_active ? <span className="live-text">Serving the running application</span> : "Not running · selecting does not switch"}</dd>
        </div>
        {generation ? (
          <div>
            <dt>Validation</dt>
            <dd>
              <button type="button" className="crumb" onClick={() => onTab("Tests")}>
                {generation.evaluation?.passed === true ? "All checks passed" : generation.evaluation?.passed === false ? "Failed" : generationStageLabel(generation)}
              </button>
            </dd>
          </div>
        ) : null}
      </dl>
      {timeline.generation_id && !generation ? (
        recordError ? <Notice tone="error">Generation record: {recordError}</Notice> : <LoadingLine label="Loading the generation record" />
      ) : null}
      {generation?.agent?.summary ? (
        <section>
          <h3>
            Agent summary <Provenance kind="observed" source={`reported by ${generation.provider}`} />
          </h3>
          <p className="summary-text">{generation.agent.summary}</p>
        </section>
      ) : null}
      {generation ? <PromptBlock prompt={generation.prompt} /> : null}
      {files.length ? (
        <section>
          <h3>
            Changed files <Provenance kind="observed" source="generation.changes" />
          </h3>
          <ReportedFiles files={files} onPick={() => onTab("Diff")} />
        </section>
      ) : null}
      {timelineOrigin(timeline) === "sprout" ? (
        <p className="fine">Sprouts are made by the engine itself, not an agent, so there is no generation record, diff or validation for this future.</p>
      ) : null}
      <LinkRow onCompare={() => navigation.compare({ kind: "timeline", id: timeline.id })} onArchitect={() => navigation.architect({ kind: "timeline", id: timeline.id })} />
      <Technical
        rows={[
          ["Timeline", timeline.id],
          ["Head snapshot", timeline.snapshot_id ?? "None"],
          ["Generation", timeline.generation_id ?? "None"],
          ...(generation?.base_snapshot_id ? ([["Base snapshot", generation.base_snapshot_id]] as Array<[string, string]>) : []),
        ]}
      />
    </div>
  );
}

function LinkRow({ onCompare, onArchitect }: { onCompare: () => void; onArchitect: () => void }) {
  return (
    <div className="link-row">
      <button type="button" className="text-btn" onClick={onCompare}>
        Compare in Analyze →
      </button>
      <button type="button" className="text-btn" onClick={onArchitect}>
        View in Architect →
      </button>
    </div>
  );
}

function PromptBlock({ prompt }: { prompt: string }) {
  return (
    <section>
      <h3>Prompt</h3>
      <p className="prompt-block">{prompt}</p>
    </section>
  );
}

function Technical({ rows }: { rows: Array<[string, string]> }) {
  return (
    <details className="more">
      <summary>Technical details</summary>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function Stepper({ generation }: { generation: Generation }) {
  const steps = lifecycleSteps(generation);
  return (
    <ol className="stepper" aria-label="Generation progress">
      {steps.map((step) => (
        <li key={step.id} className={`step is-${step.state}`} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="step-dot" aria-hidden="true" />
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function NoGeneration({ timeline }: { timeline: Timeline | null }) {
  if (!timeline) return <Notice>No generation record.</Notice>;
  const origin = timelineOrigin(timeline);
  if (origin === "root") return <Notice>The root codebase has no generation, so there is nothing to diff, log or validate.</Notice>;
  if (origin === "sprout")
    return (
      <Notice>
        Created by an engine sprout ({modificationLabel(timeline.modification)}), not by an agent. The engine does not expose diffs, logs or validation for sprouts.
      </Notice>
    );
  return <Notice>This future has no generation record, so no diff, logs or validation are available.</Notice>;
}

function DiffPanel({
  timeline,
  generation,
  generationId,
  recordError,
}: {
  timeline: Timeline | null;
  generation: Generation | null;
  generationId: string | null;
  recordError: string | null;
}) {
  const { timelines } = useWorkspace();
  const phase = generationPhase(generation?.status);
  const diff = useGenerationDiff(generationId, generation ? `${generation.status}:${generation.updated_at}` : "");
  if (!generationId) return <NoGeneration timeline={timeline} />;
  const parent = timelineById(timelines, generation?.parent_id ?? null);
  return (
    <div className="panel-stack">
      <p className="source-line">
        <Provenance kind="observed" source="GET /api/generations/{id}/diff" /> {diffProvenance(generation, parent?.name ?? null)}
      </p>
      {recordError ? <Notice tone="error">Generation record: {recordError}</Notice> : null}
      {diff.status === "loading" ? <LoadingLine label="Loading the diff" /> : null}
      {diff.status === "error" ? (
        <Notice tone="error" action={<button type="button" className="btn" onClick={diff.reload}>Retry</button>}>
          {diff.error}
        </Notice>
      ) : null}
      {diff.status === "ready" && !diff.data.trim() ? (
        <Notice>
          {phase === "active"
            ? "No changes yet. The diff appears once the agent has edited files."
            : phase === "cancelled"
              ? "Cancelled before any change was recorded. The engine returned an empty diff."
              : "The engine returned an empty diff for this generation."}
        </Notice>
      ) : null}
      {diff.status === "ready" && diff.data.trim() ? <DiffView text={diff.data} /> : null}
    </div>
  );
}

function LogsPanel({ generation, generationId }: { generation: Generation | null; generationId: string | null }) {
  const active = generationPhase(generation?.status) === "active";
  const tick = useTick(active ? 2000 : 0);
  const version = generation ? `${generation.status}:${generation.updated_at}:${active ? tick : ""}` : "";
  if (!generationId) {
    return <NoGeneration timeline={null} />;
  }
  return (
    <div className="panel-stack">
      <p className="source-line">
        <Provenance kind="observed" source="GET /api/generations/{id}/logs" /> Last 400 lines per stream{active ? ", refreshing while the generation runs" : ""}.
      </p>
      <LogBlock title="Agent" generationId={generationId} stream="agent" version={version} />
      <LogBlock title="Validation" generationId={generationId} stream="validation" version={version} />
    </div>
  );
}

function LogBlock({ title, generationId, stream, version }: { title: string; generationId: string; stream: "agent" | "validation"; version: string }) {
  const logs = useGenerationLogs(generationId, stream, version);
  return (
    <section className="log-block">
      <h3>
        {title}
        {logs.status === "ready" ? <span className="fine"> · {logs.data.lines.length} lines</span> : null}
      </h3>
      {logs.status === "loading" ? <LoadingLine label={`Loading the ${title.toLowerCase()} log`} /> : null}
      {logs.status === "error" ? (
        <Notice tone="error" action={<button type="button" className="btn" onClick={logs.reload}>Retry</button>}>
          {logs.error}
        </Notice>
      ) : null}
      {logs.status === "ready" && logs.data.lines.length === 0 ? <p className="fine">No {title.toLowerCase()} output recorded.</p> : null}
      {logs.status === "ready" && logs.data.lines.length > 0 ? <LogLines lines={logs.data.lines} /> : null}
    </section>
  );
}

function TestsPanel({
  generation,
  generationId,
  recordStatus,
  recordError,
  onTab,
}: {
  generation: Generation | null;
  generationId: string | null;
  recordStatus: string;
  recordError: string | null;
  onTab: (tab: Tab) => void;
}) {
  const { timelines, selectedId } = useWorkspace();
  if (!generationId) return <NoGeneration timeline={timelineById(timelines, selectedId)} />;
  if (recordError) return <Notice tone="error">{recordError}</Notice>;
  if (!generation || recordStatus === "loading") return <LoadingLine label="Loading validation" />;
  return (
    <div className="panel-stack">
      <p className="source-line">
        <Provenance kind="observed" source="generation.evaluation" /> Engine-run checks in contract order.{" "}
        <button type="button" className="text-btn" onClick={() => onTab("Logs")}>
          Validation log →
        </button>
      </p>
      <ChecksView generation={generation} />
    </div>
  );
}

function SnapshotsPanel({ timeline }: { timeline: Timeline }) {
  const { snapshotNonce, activeTimelineId, connected } = useWorkspace();
  const snapshots = useSnapshots(timeline.id, String(snapshotNonce));
  const { request, dialog, outcome, pendingAction, busy } = useRuntimeAction();
  const isLive = timeline.id === activeTimelineId;
  const declined = timeline.status === "declined";
  const list = snapshots.status === "ready" ? [...snapshots.data.snapshots].reverse() : [];

  return (
    <div className="panel-stack">
      <p className="source-line">
        <Provenance kind="observed" source="GET /api/timelines/{id}/snapshots" /> Immutable saves of this future's code and data, newest first.
      </p>
      <p className="fine">
        Restoring makes this future live with the code and data from that moment. The engine saves the outgoing live state first, so nothing is lost.
        {isLive ? " New snapshots can be saved only while a future is live." : ""}
      </p>
      {snapshots.status === "loading" ? <LoadingLine label="Loading snapshots" /> : null}
      {snapshots.status === "error" ? (
        <Notice tone="error" action={<button type="button" className="btn" onClick={snapshots.reload}>Retry</button>}>
          {snapshots.error}
        </Notice>
      ) : null}
      {snapshots.status === "ready" && list.length === 0 ? <Notice>No snapshots recorded for this future.</Notice> : null}
      {list.length > 0 ? (
        <ol className="snapshot-list">
          {list.map((snapshot: Snapshot) => {
            const head = snapshot.id === timeline.snapshot_id;
            const working = pendingAction?.kind === "restore" && pendingAction.snapshotId === snapshot.id;
            return (
              <li key={snapshot.id} className={head ? "snapshot is-head" : "snapshot"}>
                <div>
                  <strong>{formatStamp(snapshot.created_at)}</strong>
                  <span className="fine">
                    {formatRelative(snapshot.created_at)} · <span className="mono">{shortId(snapshot.id)}</span>
                    {head ? " · head" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={!connected || declined || Boolean(pendingAction) || busy}
                  title={declined ? "Declined futures cannot be restored." : undefined}
                  onClick={() => request("restore", timeline, snapshot)}
                >
                  {working ? "Restoring…" : "Restore"}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {outcome && outcome.timelineId === timeline.id ? (
        <p className={outcome.tone === "ok" ? "action-ok" : "inspector-error"} role="status">
          {outcome.text}
        </p>
      ) : null}
      {dialog}
    </div>
  );
}

function GhostActions({ generation }: { generation: Generation }) {
  const { cancelGeneration, connected } = useWorkspace();
  const [state, setState] = useState<{ id: string; busy: boolean; error: string | null } | null>(null);
  const phase = generationPhase(generation.status);
  const mine = state?.id === generation.id ? state : null;

  useEffect(() => {
    if (phase !== "active") setState((current) => (current && current.id === generation.id && !current.busy ? null : current));
  }, [generation.id, phase]);

  if (phase !== "active") {
    return (
      <p className="fine">
        {phase === "succeeded"
          ? "This attempt succeeded but its timeline is not in the engine's list yet."
          : phase === "unknown"
            ? "Unrecognised status: no actions are offered."
            : "Failed and cancelled attempts create no timeline. Their evidence stays inspectable."}
      </p>
    );
  }
  return (
    <div className="runtime-actions">
      <div className="action-row">
        <button
          type="button"
          className="btn ghost-danger"
          disabled={!connected || mine?.busy}
          onClick={() => {
            const id = generation.id;
            setState({ id, busy: true, error: null });
            void cancelGeneration(id).then(
              () => setState((current) => (current?.id === id ? null : current)),
              (error: unknown) => setState((current) => (current?.id === id ? { id, busy: false, error: errorMessage(error, "The generation could not be cancelled.") } : current)),
            );
          }}
        >
          {mine?.busy ? "Cancelling…" : "Cancel generation"}
        </button>
        <span className="fine">Cancelling never creates a timeline.</span>
      </div>
      {mine?.error ? <p className="inspector-error">{mine.error}</p> : null}
    </div>
  );
}

function Ancestry({ ghost }: { ghost: Generation | null }) {
  const { timelines, selectedId, selectTimeline } = useWorkspace();
  const chain = ancestry(timelines, ghost ? ghost.parent_id : selectedId);
  if (chain.length === 0) return null;
  return (
    <p className="ancestry" aria-label="Lineage">
      {chain.map((timeline, index) => (
        <span key={timeline.id}>
          {index > 0 ? <span className="sep">/</span> : null}
          <button type="button" className="crumb" onClick={() => selectTimeline(timeline.id)} aria-current={!ghost && timeline.id === selectedId ? "true" : undefined}>
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
  );
}
