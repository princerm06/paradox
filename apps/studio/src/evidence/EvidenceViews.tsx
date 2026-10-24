import { useMemo, useState, type ReactNode } from "react";
import type { ChangedFile, Generation, GenerationCheck } from "../api/types.ts";
import { parseUnifiedDiff, type DiffFile } from "../lib/diff.ts";
import { CHECK_ORDER, generationPhase } from "../lib/generation.ts";
import { shortId } from "../lib/format.ts";

/** Small provenance tag: where a fact came from. */
export function Provenance({ kind, source }: { kind: "observed" | "documented" | "inferred" | "unavailable" | "simulated"; source?: string }) {
  const label = { observed: "Observed", documented: "Documented", inferred: "Inferred", unavailable: "Unavailable", simulated: "Fixture" }[kind];
  return (
    <span className={`prov prov-${kind}`} title={source ? `${label} · ${source}` : label}>
      {label}
      {source ? <span className="prov-src">{source}</span> : null}
    </span>
  );
}

export function Notice({ tone = "quiet", children, action }: { tone?: "quiet" | "error" | "warn"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <div>{children}</div>
      {action}
    </div>
  );
}

export function LoadingLine({ label }: { label: string }) {
  return (
    <p className="loading-line" aria-live="polite">
      <span className="spinner small" aria-hidden="true" />
      {label}
    </p>
  );
}

export function FileStatusMark({ status }: { status: string }) {
  const letter = status === "added" ? "A" : status === "deleted" ? "D" : status === "modified" ? "M" : "?";
  return (
    <span className={`file-mark is-${status}`} title={status}>
      {letter}
    </span>
  );
}

export function ChangeCount({ additions, deletions }: { additions?: number | null; deletions?: number | null }) {
  return (
    <span className="change-count">
      {typeof additions === "number" ? <span className="plus">+{additions}</span> : null}
      {typeof deletions === "number" ? <span className="minus">−{deletions}</span> : null}
    </span>
  );
}

export function ReportedFiles({ files, onPick }: { files: ChangedFile[]; onPick?: (path: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ul className="file-list">
      {files.map((file) => (
        <li key={file.path}>
          <FileStatusMark status={file.status} />
          {onPick ? (
            <button type="button" className="file-path linkish" onClick={() => onPick(file.path)}>
              {file.path}
            </button>
          ) : (
            <span className="file-path">{file.path}</span>
          )}
          <ChangeCount additions={file.additions} deletions={file.deletions} />
        </li>
      ))}
    </ul>
  );
}

/** Rendered unified diff, collapsible per file. `focusPath` opens only that file. */
export function DiffView({ text, focusPath, compact = false }: { text: string; focusPath?: string | null; compact?: boolean }) {
  const files = useMemo(() => parseUnifiedDiff(text), [text]);
  if (files.length === 0) {
    return <pre className="diff raw">{text}</pre>;
  }
  const shown = focusPath ? files.filter((file) => file.path === focusPath) : files;
  return (
    <div className={compact ? "diff-files compact" : "diff-files"}>
      {(shown.length ? shown : files).map((file, index) => (
        <DiffFileView key={file.path} file={file} defaultOpen={!compact || Boolean(focusPath) || index === 0} />
      ))}
    </div>
  );
}

function DiffFileView({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="diff-file">
      <button type="button" className="diff-file-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <FileStatusMark status={file.status} />
        <span className="file-path">{file.path}</span>
        <ChangeCount additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        <div className="diff-body" role="table" aria-label={`Changes in ${file.path}`}>
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex} role="rowgroup">
              <div className="diff-row hunk" role="row">
                <span className="ln" />
                <span className="ln" />
                <code>{hunk.header}</code>
              </div>
              {hunk.lines.map((line, index) => (
                <div key={index} className={`diff-row ${line.kind}`} role="row">
                  <span className="ln">{line.oldNo ?? ""}</span>
                  <span className="ln">{line.newNo ?? ""}</span>
                  <code>
                    <span className="sigil" aria-hidden="true">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    </span>
                    {line.text || " "}
                  </code>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export type CheckCell = { name: string; check: GenerationCheck | null; note: string };

/**
 * Checks in the contract's fixed order. Missing checks are labelled by why they
 * are missing (not reached, still running, never started) — never as passed.
 */
export function checkCells(generation: Generation | null): CheckCell[] {
  const checks = generation?.evaluation?.checks ?? [];
  const byName = new Map(checks.map((check) => [check.name, check]));
  const phase = generationPhase(generation?.status);
  const failedAt = checks.findIndex((check) => check.status === "failed");
  const cells: CheckCell[] = CHECK_ORDER.map((name, index) => {
    const check = byName.get(name) ?? null;
    let note = "";
    if (!check) {
      if (!generation) note = "No generation record";
      else if (phase === "active") note = "Not reported yet";
      else if (failedAt >= 0 && index > CHECK_ORDER.indexOf(checks[failedAt].name as (typeof CHECK_ORDER)[number])) note = "Not run: stopped at first failure";
      else if (phase === "cancelled") note = "Not run: cancelled";
      else if (phase === "failed") note = "Not run";
      else note = "Not reported";
    }
    return { name, check, note };
  });
  for (const check of checks) {
    if (!(CHECK_ORDER as readonly string[]).includes(check.name)) cells.push({ name: check.name, check, note: "" });
  }
  return cells;
}

export function ChecksView({ generation }: { generation: Generation }) {
  const evaluation = generation.evaluation;
  const phase = generationPhase(generation.status);
  return (
    <div className="checks-view">
      <div className="checks-summary">
        {typeof evaluation?.passed === "boolean" ? (
          <span className={evaluation.passed ? "verdict ok" : "verdict bad"}>{evaluation.passed ? "All six checks passed" : "Validation failed"}</span>
        ) : (
          <span className="verdict">{phase === "active" ? "Validation in progress" : "No validation verdict reported"}</span>
        )}
        <TestCounts generation={generation} />
      </div>
      <ol className="check-list">
        {checkCells(generation).map((cell) => (
          <li key={cell.name} className={`check-item is-${cell.check?.status ?? "absent"}`}>
            <span className="check-dot" aria-hidden="true" />
            <span className="check-name">{cell.name}</span>
            <span className="check-status">{cell.check ? cell.check.status : cell.note}</span>
            <span className="check-time">{typeof cell.check?.duration_ms === "number" ? `${cell.check.duration_ms} ms` : ""}</span>
            {cell.check?.detail ? <span className="check-detail">{cell.check.detail}</span> : null}
          </li>
        ))}
      </ol>
      {typeof evaluation?.boot_ms === "number" ? <p className="fine">Validation boot of a throwaway runtime took {evaluation.boot_ms} ms.</p> : null}
    </div>
  );
}

export function TestCounts({ generation }: { generation: Generation | null }) {
  const tests = generation?.evaluation?.tests;
  if (!tests || (typeof tests.passed !== "number" && typeof tests.failed !== "number" && typeof tests.errors !== "number")) {
    return <span className="test-counts muted">No test counts reported</span>;
  }
  return (
    <span className="test-counts">
      {typeof tests.passed === "number" ? <span className="ok">{tests.passed} passed</span> : null}
      {typeof tests.failed === "number" ? <span className={tests.failed ? "bad" : ""}>{tests.failed} failed</span> : null}
      {typeof tests.errors === "number" ? <span className={tests.errors ? "bad" : ""}>{tests.errors} errors</span> : null}
    </span>
  );
}

export function LogLines({ lines }: { lines: string[] }) {
  return (
    <pre className="log" tabIndex={0}>
      {lines.map((line, index) => (
        <span key={index} className={/fail|error|traceback/i.test(line) ? "log-line bad" : /passed|200\b/.test(line) ? "log-line ok" : "log-line"}>
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function diffProvenance(generation: Generation | null, parentName: string | null): string {
  if (!generation) return "";
  const base = generation.base_snapshot_id ? `base snapshot ${shortId(generation.base_snapshot_id)}` : "its base snapshot";
  return `Unified diff of this generation against ${base}${parentName ? `, the head of ${parentName} when it started` : ""}.`;
}
