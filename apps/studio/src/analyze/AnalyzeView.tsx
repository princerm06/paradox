import { useEffect, useMemo, useState } from "react";
import type { Generation } from "../api/types.ts";
import { ChangeCount, ChecksView, DiffView, FileStatusMark, LoadingLine, LogLines, Notice, Provenance, TestCounts, checkCells, diffProvenance } from "../evidence/EvidenceViews.tsx";
import { timelineById } from "../graph/tree.ts";
import { ANALYSIS_LOG_TAIL, useGenerationDiff, useGenerationLogs, useGenerationRecord } from "../hooks/evidence.ts";
import { reportedFiles } from "../lib/diff.ts";
import { formatRelative, formatStamp, generationStageLabel, modificationLabel, shortId, statusLabel } from "../lib/format.ts";
import { generationPhase } from "../lib/generation.ts";
import { lineageRelation, resolveSubject, sameSubject, subjectKey, subjectOptions, type Resolved } from "../lib/subject.ts";
import { useNavigation, type Subject } from "../shell/navigation.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { compareSubjects, type Comparison } from "./compare.ts";

const TABS = ["Summary", "Validation", "Files", "Diffs", "Logs"] as const;
type Tab = (typeof TABS)[number];

export function AnalyzeView({ onConsumed }: { onConsumed: () => void }) {
  const workspace = useWorkspace();
  const navigation = useNavigation();
  const { timelines, generations, activeTimelineId } = workspace;
  const [tab, setTab] = useState<Tab>("Summary");
  const [a, setA] = useState<Subject | null>(() => (activeTimelineId ? { kind: "timeline", id: activeTimelineId } : null));
  const [b, setB] = useState<Subject | null>(() => {
    if (navigation.pendingCompare) return navigation.pendingCompare;
    if (workspace.selectedGenerationId) return { kind: "generation", id: workspace.selectedGenerationId };
    if (workspace.selectedId && workspace.selectedId !== activeTimelineId) return { kind: "timeline", id: workspace.selectedId };
    return null;
  });

  // Fill sensible defaults once data arrives; never touches the runtime.
  useEffect(() => {
    if (!a && activeTimelineId) setA({ kind: "timeline", id: activeTimelineId });
  }, [a, activeTimelineId]);
  useEffect(() => {
    if (b || !timelines.length) return;
    const other = [...timelines].reverse().find((timeline) => timeline.id !== activeTimelineId);
    if (other) setB({ kind: "timeline", id: other.id });
  }, [b, timelines, activeTimelineId]);
  useEffect(() => {
    const pending = navigation.pendingCompare;
    if (!pending) return;
    setB(pending);
    if (sameSubject(pending, a)) {
      const resolved = resolveSubject(pending, timelines, generations);
      if (resolved?.parent) setA({ kind: "timeline", id: resolved.parent.id });
    }
    onConsumed();
  }, [navigation.pendingCompare, a, generations, onConsumed, timelines]);

  const left = resolveSubject(a, timelines, generations);
  const right = resolveSubject(b, timelines, generations);
  const leftRecord = useGenerationRecord(left?.generationId ?? null, left?.generation ?? null);
  const rightRecord = useGenerationRecord(right?.generationId ?? null, right?.generation ?? null);
  const comparison = useMemo(() => compareSubjects(left, leftRecord.record, right, rightRecord.record), [left, leftRecord.record, right, rightRecord.record]);
  const options = subjectOptions(timelines, generations);

  return (
    <div className="mode-view analyze">
      <header className="mode-head glass-panel">
        <div className="mode-title">
          <p className="brand-kicker">Analyze</p>
          <h1>Compare futures</h1>
        </div>
        <div className="versus">
          <SubjectSelect label="A" value={a} options={options} onChange={setA} />
          <button type="button" className="icon-btn swap" aria-label="Swap A and B" onClick={() => { setA(b); setB(a); }}>
            ⇄
          </button>
          <SubjectSelect label="B" value={b} options={options} onChange={setB} />
        </div>
        <p className="fine select-note">Choosing futures here never activates them.</p>
      </header>

      {left && right ? (
        <p className="lineage-line">
          <Provenance kind="observed" source="parent_id links" /> {lineageRelation(left, right, timelines)}
        </p>
      ) : null}

      <div className="tabs analyze-tabs" role="tablist" aria-label="Comparison sections">
        {TABS.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "tab is-on" : "tab"} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      <section className="analyze-body" role="tabpanel" aria-label={tab}>
        {!left || !right ? (
          <Notice>{timelines.length ? "Choose two futures to compare." : workspace.connected ? "Waiting for the engine's timeline list." : "The engine is offline; nothing to compare yet."}</Notice>
        ) : (
          <>
            {tab === "Summary" ? <Summary left={left} right={right} leftGen={leftRecord.record} rightGen={rightRecord.record} comparison={comparison} errors={[leftRecord.error, rightRecord.error]} /> : null}
            {tab === "Validation" ? <ValidationCompare left={left} right={right} leftGen={leftRecord.record} rightGen={rightRecord.record} /> : null}
            {tab === "Files" ? <FilesCompare left={left} right={right} comparison={comparison} /> : null}
            {tab === "Diffs" ? (
              <div className="pair">
                <DiffColumn side="A" subject={left} generation={leftRecord.record} />
                <DiffColumn side="B" subject={right} generation={rightRecord.record} />
              </div>
            ) : null}
            {tab === "Logs" ? (
              <div className="pair">
                <LogColumn side="A" subject={left} generation={leftRecord.record} />
                <LogColumn side="B" subject={right} generation={rightRecord.record} />
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function SubjectSelect({ label, value, options, onChange }: { label: string; value: Subject | null; options: ReturnType<typeof subjectOptions>; onChange: (subject: Subject | null) => void }) {
  return (
    <label className={`subject-pick side-${label.toLowerCase()}`}>
      <span className="side-tag">{label}</span>
      <select
        value={subjectKey(value)}
        onChange={(event) => {
          const option = options.find((item) => subjectKey(item.subject) === event.target.value);
          onChange(option ? option.subject : null);
        }}
        aria-label={`Future ${label}`}
      >
        {!value ? <option value="">Choose a future</option> : null}
        {(["Timelines", "Attempts without a timeline"] as const).map((group) => {
          const items = options.filter((item) => item.group === group);
          if (!items.length) return null;
          return (
            <optgroup key={group} label={group}>
              {items.map((item) => (
                <option key={subjectKey(item.subject)} value={subjectKey(item.subject)}>
                  {item.label} · {item.detail}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

function originLabel(subject: Resolved, generation: Generation | null): string {
  if (subject.origin === "root") return "Root codebase";
  if (subject.origin === "sprout") return `Engine sprout · ${modificationLabel(subject.timeline?.modification ?? null)}`;
  if (subject.origin === "ai") return generation ? `AI generation · ${generation.provider}` : "AI generation";
  return "Origin not recorded";
}

function Summary({
  left,
  right,
  leftGen,
  rightGen,
  comparison,
  errors,
}: {
  left: Resolved;
  right: Resolved;
  leftGen: Generation | null;
  rightGen: Generation | null;
  comparison: Comparison;
  errors: Array<string | null>;
}) {
  return (
    <div className="summary">
      <div className="pair">
        <SubjectCard side="A" subject={left} generation={leftGen} error={errors[0]} />
        <SubjectCard side="B" subject={right} generation={rightGen} error={errors[1]} />
      </div>
      <section className="findings glass-panel">
        <h2>
          Differences <Provenance kind="observed" source="engine records" />
        </h2>
        {comparison.findings.length === 0 ? <p className="fine">No recorded differences between these two futures.</p> : null}
        <ul>
          {comparison.findings.map((finding) => (
            <li key={finding.text} className={`finding is-${finding.tone}`}>
              <span className="finding-mark" aria-hidden="true" />
              {finding.text}
            </li>
          ))}
        </ul>
        {comparison.caveats.map((caveat) => (
          <p key={caveat} className="fine">
            {caveat}
          </p>
        ))}
      </section>
    </div>
  );
}

function SubjectCard({ side, subject, generation, error }: { side: "A" | "B"; subject: Resolved; generation: Generation | null; error: string | null }) {
  const navigation = useNavigation();
  const { activeTimelineId } = useWorkspace();
  const timeline = subject.timeline;
  const phase = generation ? generationPhase(generation.status) : null;
  return (
    <article className={`subject-card glass-panel side-${side.toLowerCase()}`}>
      <header>
        <span className="side-tag">{side}</span>
        <div>
          <h2 title={subject.name}>{subject.name}</h2>
          <p className="fine">{originLabel(subject, generation)}</p>
        </div>
      </header>
      <div className="identity">
        {timeline ? <span className={`pill status-${timeline.parent_id ? timeline.status : "root"}`}>{statusLabel(timeline)}</span> : null}
        {timeline?.id === activeTimelineId ? <span className="pill live">Live</span> : null}
        {!timeline && generation ? <span className={`pill phase-${phase}`}>{generationStageLabel(generation)}</span> : null}
        {!timeline ? <span className="pill">No timeline</span> : null}
        {generation?.evaluation?.passed === true ? <span className="pill ok">Checks passed</span> : null}
        {generation?.evaluation?.passed === false ? <span className="pill bad">Checks failed</span> : null}
      </div>
      <dl className="facts">
        <div>
          <dt>Parent</dt>
          <dd>{subject.parent ? subject.parent.name : subject.origin === "root" ? "None" : "Missing"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {formatStamp(timeline?.created_at ?? generation?.created_at ?? "")} <span className="fine">{formatRelative(timeline?.created_at ?? generation?.created_at ?? "")}</span>
          </dd>
        </div>
        {generation ? (
          <>
            <div>
              <dt>Provider</dt>
              <dd>{generation.provider}</dd>
            </div>
            <div>
              <dt>Tests</dt>
              <dd>
                <TestCounts generation={generation} />
              </dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{reportedFiles(generation).length} changed</dd>
            </div>
            <div>
              <dt>Base</dt>
              <dd className="mono">{shortId(generation.base_snapshot_id)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {subject.generationId && !generation ? error ? <Notice tone="error">{error}</Notice> : <LoadingLine label="Loading generation record" /> : null}
      {!subject.generationId ? (
        <p className="fine">{subject.origin === "root" ? "Root: no generation, diff or validation exists." : subject.origin === "sprout" ? "Engine sprout: the engine records no generation, diff or validation." : "No generation record."}</p>
      ) : null}
      {generation?.error?.message ? (
        <Notice tone="error">
          {generation.error.stage ? `${generation.error.stage}: ` : ""}
          {generation.error.message}
        </Notice>
      ) : null}
      {generation ? <p className="prompt-block">{generation.prompt}</p> : null}
      {generation?.agent?.summary ? <p className="summary-text">{generation.agent.summary}</p> : null}
      <div className="link-row">
        <button type="button" className="text-btn" onClick={() => (subject.subject.kind === "timeline" ? navigation.inspectTimeline(subject.subject.id) : navigation.inspectGeneration(subject.subject.id))}>
          Inspect in Explore →
        </button>
        <button type="button" className="text-btn" onClick={() => navigation.architect(subject.subject)}>
          Architect →
        </button>
      </div>
    </article>
  );
}

function ValidationCompare({ left, right, leftGen, rightGen }: { left: Resolved; right: Resolved; leftGen: Generation | null; rightGen: Generation | null }) {
  const leftCells = checkCells(leftGen);
  const rightCells = checkCells(rightGen);
  const names = [...new Set([...leftCells.map((cell) => cell.name), ...rightCells.map((cell) => cell.name)])];
  return (
    <div className="panel-stack">
      <p className="source-line">
        <Provenance kind="observed" source="generation.evaluation" /> Engine-run checks in contract order. Checks the engine did not run are labelled, never counted as passed.
      </p>
      <table className="matrix">
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">
              <span className="side-tag">A</span> {left.name}
            </th>
            <th scope="col">
              <span className="side-tag b">B</span> {right.name}
            </th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const l = leftCells.find((cell) => cell.name === name);
            const r = rightCells.find((cell) => cell.name === name);
            const differs = (l?.check?.status ?? "") !== (r?.check?.status ?? "");
            return (
              <tr key={name} className={differs ? "differs" : undefined}>
                <th scope="row">{name}</th>
                <MatrixCell cell={l} hasGeneration={Boolean(leftGen)} />
                <MatrixCell cell={r} hasGeneration={Boolean(rightGen)} />
              </tr>
            );
          })}
          <tr>
            <th scope="row">tests (counts)</th>
            <td>
              <TestCounts generation={leftGen} />
            </td>
            <td>
              <TestCounts generation={rightGen} />
            </td>
          </tr>
        </tbody>
      </table>
      <div className="pair">
        {leftGen ? <ChecksDetail side="A" generation={leftGen} /> : <Notice>A has no generation record.</Notice>}
        {rightGen ? <ChecksDetail side="B" generation={rightGen} /> : <Notice>B has no generation record.</Notice>}
      </div>
    </div>
  );
}

function ChecksDetail({ side, generation }: { side: string; generation: Generation }) {
  return (
    <section className="glass-panel pad">
      <h3>
        <span className={side === "B" ? "side-tag b" : "side-tag"}>{side}</span> {generation.name}
      </h3>
      <ChecksView generation={generation} />
    </section>
  );
}

function MatrixCell({ cell, hasGeneration }: { cell: ReturnType<typeof checkCells>[number] | undefined; hasGeneration: boolean }) {
  if (!hasGeneration) return <td className="muted">No generation</td>;
  if (!cell?.check) return <td className="muted">{cell?.note ?? "—"}</td>;
  return (
    <td className={`cell-${cell.check.status}`}>
      <strong>{cell.check.status}</strong>
      {typeof cell.check.duration_ms === "number" ? <span className="fine"> · {cell.check.duration_ms} ms</span> : null}
      {cell.check.detail ? <span className="cell-detail">{cell.check.detail}</span> : null}
    </td>
  );
}

function FilesCompare({ left, right, comparison }: { left: Resolved; right: Resolved; comparison: Comparison }) {
  if (!comparison.rows.length) {
    return <Notice>Neither future has a recorded change set. Roots and engine sprouts have none; failed or cancelled attempts may have stopped before editing.</Notice>;
  }
  return (
    <div className="panel-stack">
      <p className="source-line">
        <Provenance kind="observed" source="generation.changes" /> Each side's files are relative to <strong>its own</strong> base snapshot. This table lines them up by path; it is not a patch between A and B.
      </p>
      {comparison.baseNote ? <p className="fine">{comparison.baseNote}</p> : null}
      <table className="matrix files">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">
              <span className="side-tag">A</span> {left.name}
            </th>
            <th scope="col">
              <span className="side-tag b">B</span> {right.name}
            </th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.path} className={row.a && row.b ? "both" : undefined}>
              <th scope="row" className="mono">
                {row.path}
              </th>
              <td>
                {row.a ? (
                  <>
                    <FileStatusMark status={row.a.status} /> <ChangeCount additions={row.a.additions} deletions={row.a.deletions} />
                  </>
                ) : (
                  <span className="muted">unchanged</span>
                )}
              </td>
              <td>
                {row.b ? (
                  <>
                    <FileStatusMark status={row.b.status} /> <ChangeCount additions={row.b.additions} deletions={row.b.deletions} />
                  </>
                ) : (
                  <span className="muted">unchanged</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine">"Unchanged" means the side's generation did not report the file; files inherited from ancestors are not listed by the engine.</p>
    </div>
  );
}

function DiffColumn({ side, subject, generation }: { side: "A" | "B"; subject: Resolved; generation: Generation | null }) {
  const { timelines } = useWorkspace();
  const diff = useGenerationDiff(subject.generationId, generation ? `${generation.status}:${generation.updated_at}` : "");
  const parent = timelineById(timelines, generation?.parent_id ?? null);
  return (
    <section className="glass-panel pad diff-col">
      <h3>
        <span className={side === "B" ? "side-tag b" : "side-tag"}>{side}</span> {subject.name}
      </h3>
      {!subject.generationId ? (
        <Notice>{subject.origin === "root" ? "Root codebase: no diff." : subject.origin === "sprout" ? "Engine sprout: the engine exposes no diff." : "No generation record, so no diff."}</Notice>
      ) : (
        <>
          <p className="source-line">
            <Provenance kind="observed" source="GET /api/generations/{id}/diff" /> {diffProvenance(generation, parent?.name ?? null)}
          </p>
          {diff.status === "loading" ? <LoadingLine label="Loading diff" /> : null}
          {diff.status === "error" ? (
            <Notice tone="error" action={<button type="button" className="btn" onClick={diff.reload}>Retry</button>}>
              {diff.error}
            </Notice>
          ) : null}
          {diff.status === "ready" && !diff.data.trim() ? <Notice>The engine returned an empty diff.</Notice> : null}
          {diff.status === "ready" && diff.data.trim() ? <DiffView text={diff.data} compact /> : null}
        </>
      )}
    </section>
  );
}

function LogColumn({ side, subject, generation }: { side: "A" | "B"; subject: Resolved; generation: Generation | null }) {
  const version = generation ? `${generation.status}:${generation.updated_at}` : "";
  const agent = useGenerationLogs(subject.generationId, "agent", version, ANALYSIS_LOG_TAIL);
  const validation = useGenerationLogs(subject.generationId, "validation", version, ANALYSIS_LOG_TAIL);
  return (
    <section className="glass-panel pad diff-col">
      <h3>
        <span className={side === "B" ? "side-tag b" : "side-tag"}>{side}</span> {subject.name}
      </h3>
      {!subject.generationId ? (
        <Notice>No generation record, so no logs.</Notice>
      ) : (
        <>
          <p className="source-line">
            <Provenance kind="observed" source="GET /api/generations/{id}/logs" /> Up to the last {ANALYSIS_LOG_TAIL} lines per stream.
          </p>
          {[
            ["Agent", agent],
            ["Validation", validation],
          ].map(([title, logs]) => {
            const resource = logs as typeof agent;
            return (
              <div key={title as string} className="log-block">
                <h4>
                  {title as string}
                  {resource.status === "ready" ? (
                    <span className="fine">
                      {" "}
                      · {resource.data.lines.length} line{resource.data.lines.length === 1 ? "" : "s"}
                      {resource.data.lines.length >= ANALYSIS_LOG_TAIL ? " (truncated)" : ""}
                    </span>
                  ) : null}
                </h4>
                {resource.status === "loading" ? <LoadingLine label="Loading" /> : null}
                {resource.status === "error" ? <Notice tone="error">{resource.error}</Notice> : null}
                {resource.status === "ready" && resource.data.lines.length === 0 ? <p className="fine">No output recorded.</p> : null}
                {resource.status === "ready" && resource.data.lines.length > 0 ? <LogLines lines={resource.data.lines} /> : null}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
