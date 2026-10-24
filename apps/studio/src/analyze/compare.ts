import type { ChangedFile, Generation } from "../api/types.ts";
import { reportedFiles } from "../lib/diff.ts";
import { generationPhase } from "../lib/generation.ts";
import { shortId } from "../lib/format.ts";
import type { Resolved } from "../lib/subject.ts";

export type Finding = { text: string; tone: "neutral" | "good" | "bad" | "warn" };
export type FileRow = { path: string; a: ChangedFile | null; b: ChangedFile | null };
export type Comparison = { findings: Finding[]; caveats: string[]; rows: FileRow[]; baseNote: string | null };

function verdict(generation: Generation | null): string {
  if (!generation) return "no generation";
  const phase = generationPhase(generation.status);
  if (phase === "failed") return generation.error?.stage ? `failed at ${generation.error.stage}` : "failed";
  if (phase === "cancelled") return "was cancelled";
  if (phase === "active") return `is still ${generation.status}`;
  if (phase === "unknown") return `has unrecognised status "${generation.status}"`;
  return generation.evaluation?.passed ? "passed all six checks" : "succeeded";
}

function testsText(generation: Generation | null): string | null {
  const tests = generation?.evaluation?.tests;
  if (!tests) return null;
  return [typeof tests.passed === "number" ? `${tests.passed} passed` : null, typeof tests.failed === "number" && tests.failed ? `${tests.failed} failed` : null, typeof tests.errors === "number" && tests.errors ? `${tests.errors} errors` : null]
    .filter(Boolean)
    .join(", ");
}

/**
 * Compare two futures using only what the engine recorded. Nothing here is a
 * computed A↔B patch: each side's files and diff are relative to its own base.
 */
export function compareSubjects(left: Resolved | null, leftGen: Generation | null, right: Resolved | null, rightGen: Generation | null): Comparison {
  const findings: Finding[] = [];
  const caveats: string[] = [];
  if (!left || !right) return { findings, caveats, rows: [], baseNote: null };
  if (left.key === right.key) {
    return { findings: [{ text: "A and B are the same future.", tone: "warn" }], caveats, rows: [], baseNote: null };
  }

  const aLive = Boolean(left.timeline?.is_active);
  const bLive = Boolean(right.timeline?.is_active);
  if (aLive !== bLive) findings.push({ text: `${aLive ? left.name : right.name} is serving the runtime; ${aLive ? right.name : left.name} is not.`, tone: "neutral" });

  if (left.timeline && right.timeline && left.timeline.status !== right.timeline.status && left.timeline.parent_id && right.timeline.parent_id) {
    findings.push({ text: `Decision: A is ${left.timeline.status}, B is ${right.timeline.status}.`, tone: "neutral" });
  }
  if (!left.timeline || !right.timeline) {
    const ghost = !left.timeline ? left : right;
    findings.push({ text: `${ghost.name} never produced a timeline, so it cannot be activated or restored.`, tone: "warn" });
  }

  if (leftGen || rightGen) {
    const a = verdict(leftGen);
    const b = verdict(rightGen);
    if (a !== b) {
      const tone = leftGen?.evaluation?.passed && rightGen?.evaluation?.passed === false ? "bad" : rightGen?.evaluation?.passed && leftGen?.evaluation?.passed === false ? "bad" : "neutral";
      findings.push({ text: `Validation: A ${a}; B ${b}.`, tone });
    } else if (leftGen && rightGen) {
      findings.push({ text: `Validation: both ${a}.`, tone: leftGen.evaluation?.passed ? "good" : "neutral" });
    }
  }

  if (leftGen && rightGen) {
    const aChecks = leftGen.evaluation?.checks ?? [];
    const bChecks = rightGen.evaluation?.checks ?? [];
    const names = [...new Set([...aChecks.map((check) => check.name), ...bChecks.map((check) => check.name)])];
    const diverge = names.find((name) => aChecks.find((check) => check.name === name)?.status !== bChecks.find((check) => check.name === name)?.status);
    if (diverge) {
      const aStatus = aChecks.find((check) => check.name === diverge)?.status ?? "not run";
      const bStatus = bChecks.find((check) => check.name === diverge)?.status ?? "not run";
      findings.push({ text: `First diverging check: ${diverge} (A ${aStatus}, B ${bStatus}).`, tone: "warn" });
    }
    const aTests = testsText(leftGen);
    const bTests = testsText(rightGen);
    if (aTests !== bTests && (aTests || bTests)) findings.push({ text: `Tests reported: A ${aTests || "none"}; B ${bTests || "none"}.`, tone: "neutral" });
    if (leftGen.provider !== rightGen.provider) findings.push({ text: `Providers differ: A ${leftGen.provider}, B ${rightGen.provider}.`, tone: "neutral" });
  }

  const aFiles = reportedFiles(leftGen);
  const bFiles = reportedFiles(rightGen);
  const paths = [...new Set([...aFiles.map((file) => file.path), ...bFiles.map((file) => file.path)])].sort();
  const rows: FileRow[] = paths.map((path) => ({ path, a: aFiles.find((file) => file.path === path) ?? null, b: bFiles.find((file) => file.path === path) ?? null }));
  if (rows.length) {
    const both = rows.filter((row) => row.a && row.b).length;
    const onlyA = rows.filter((row) => row.a && !row.b).length;
    const onlyB = rows.filter((row) => !row.a && row.b).length;
    findings.push({ text: `Changed files: ${both} touched by both, ${onlyA} only by A, ${onlyB} only by B.`, tone: "neutral" });
  }

  let baseNote: string | null = null;
  if (leftGen && rightGen) {
    if (leftGen.base_snapshot_id && leftGen.base_snapshot_id === rightGen.base_snapshot_id) {
      baseNote = `Both generations started from the same base snapshot (${shortId(leftGen.base_snapshot_id)}), so their file lists are directly comparable — but Paradox still shows two diffs, not a patch between them.`;
    } else {
      baseNote = `The generations started from different base snapshots (A ${shortId(leftGen.base_snapshot_id)}, B ${shortId(rightGen.base_snapshot_id)}). Matching paths may have different starting content.`;
    }
    caveats.push("Diffs are each relative to their own base snapshot. The engine has no endpoint for a direct A↔B diff, so none is shown.");
  } else {
    const missing = !leftGen ? left : right;
    if (!(!leftGen && !rightGen)) caveats.push(`${missing.name} has no generation record (${missing.origin === "root" ? "root" : missing.origin === "sprout" ? "engine sprout" : "none recorded"}), so file and validation evidence is one-sided.`);
    else caveats.push("Neither side has a generation record, so only lineage and decision state can be compared.");
  }
  return { findings, caveats, rows, baseNote };
}
