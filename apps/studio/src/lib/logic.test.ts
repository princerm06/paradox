import { describe, expect, it } from "vitest";
import { compareSubjects } from "../analyze/compare.ts";
import { normalizeBase } from "../api/config.ts";
import { checkCells } from "../evidence/EvidenceViews.tsx";
import { mergeGenerations } from "../state/workspace.tsx";
import { DIFF_AI, FakeEngine, IDS, generation } from "../test/fakeEngine.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { generationPhase, isActiveGeneration, lifecycleSteps } from "./generation.ts";
import { lineageRelation, resolveSubject } from "./subject.ts";

describe("parseUnifiedDiff", () => {
  it("parses files, statuses, counts and line numbers from an engine diff", () => {
    const files = parseUnifiedDiff(DIFF_AI);
    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["demo_app/ranking.py", "modified", 2, 2],
      ["demo_app/tests/test_generated_popular_feed.py", "added", 3, 0],
    ]);
    const first = files[0].hunks[0].lines;
    expect(first[0]).toMatchObject({ kind: "del", oldNo: 1, newNo: null });
    expect(first[1]).toMatchObject({ kind: "add", oldNo: null, newNo: 1 });
  });
  it("returns no files for an empty body", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n")).toEqual([]);
  });
  it("marks deletions", () => {
    const files = parseUnifiedDiff("--- a/demo_app/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x = 1\n");
    expect(files[0]).toMatchObject({ path: "demo_app/old.py", status: "deleted", deletions: 1 });
  });
});

describe("generation status", () => {
  it("never treats unknown statuses as running", () => {
    expect(generationPhase("validating")).toBe("active");
    expect(generationPhase("paused")).toBe("unknown");
    expect(generationPhase(undefined)).toBe("unknown");
    expect(isActiveGeneration("weird")).toBe(false);
    const steps = lifecycleSteps({ status: "weird", error: null });
    expect(steps.every((step) => step.state === "todo")).toBe(true);
  });
  it("shows where a failed run stopped", () => {
    const steps = lifecycleSteps({ status: "failed", error: { stage: "compile" } });
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "done", "failed"]);
    const cancelled = lifecycleSteps({ status: "cancelled", error: { stage: "agent" } });
    expect(cancelled.map((step) => step.state)).toEqual(["done", "done", "failed", "skipped"]);
  });
  it("labels checks that never ran instead of treating them as passed", () => {
    const failed = new FakeEngine().generations.find((item) => item.id === IDS.GEN_FAILED)!;
    const cells = checkCells(failed);
    expect(cells.find((cell) => cell.name === "compile")?.check?.status).toBe("failed");
    expect(cells.find((cell) => cell.name === "tests")).toMatchObject({ check: null, note: "Not run: stopped at first failure" });
    const running = checkCells(generation({ id: "x", status: "generating", evaluation: null }));
    expect(running.every((cell) => cell.note === "Not reported yet")).toBe(true);
  });
});

describe("mergeGenerations", () => {
  it("does not let a stale poll response regress a newer record", () => {
    const newer = generation({ id: "g", status: "cancelled", updated_at: "2026-10-24T01:00:05+00:00" });
    const stale = generation({ id: "g", status: "generating", updated_at: "2026-10-24T01:00:01+00:00" });
    expect(mergeGenerations([newer], [stale], false)[0].status).toBe("cancelled");
  });
  it("keeps just-created active records missing from an older list", () => {
    const created = generation({ id: "new", status: "queued" });
    const old = generation({ id: "old", status: "failed" });
    const merged = mergeGenerations([created, old], [old], true);
    expect(merged.map((item) => item.id).sort()).toEqual(["new", "old"]);
  });
});

describe("compareSubjects", () => {
  const engine = new FakeEngine();
  const timelines = engine.view();
  it("never claims a direct A-to-B patch and reports the first diverging check", () => {
    const a = resolveSubject({ kind: "timeline", id: IDS.AI }, timelines, engine.generations)!;
    const b = resolveSubject({ kind: "generation", id: IDS.GEN_FAILED }, timelines, engine.generations)!;
    const result = compareSubjects(a, a.generation, b, b.generation);
    expect(result.caveats.join(" ")).toMatch(/no endpoint for a direct A↔B diff/);
    expect(result.findings.map((finding) => finding.text)).toContain("First diverging check: compile (A passed, B failed).");
    expect(result.baseNote).toMatch(/same base snapshot/);
    expect(result.rows.find((row) => row.path === "demo_app/ranking.py")).toMatchObject({ a: { status: "modified" }, b: { status: "modified" } });
  });
  it("is one-sided for roots and sprouts", () => {
    const root = resolveSubject({ kind: "timeline", id: IDS.ROOT }, timelines, engine.generations)!;
    const sprout = resolveSubject({ kind: "timeline", id: IDS.POPULAR }, timelines, engine.generations)!;
    expect(root.origin).toBe("root");
    expect(sprout.origin).toBe("sprout");
    const result = compareSubjects(root, null, sprout, null);
    expect(result.rows).toEqual([]);
    expect(result.caveats[0]).toMatch(/Neither side has a generation record/);
  });
  it("describes lineage from parent links only", () => {
    const root = resolveSubject({ kind: "timeline", id: IDS.ROOT }, timelines, engine.generations)!;
    const ai = resolveSubject({ kind: "timeline", id: IDS.AI }, timelines, engine.generations)!;
    const pop = resolveSubject({ kind: "timeline", id: IDS.POPULAR }, timelines, engine.generations)!;
    expect(lineageRelation(root, ai, timelines)).toBe("UI popular descends from Original (1 step).");
    expect(lineageRelation(pop, ai, timelines)).toBe("Diverge from Original.");
  });
});

describe("normalizeBase", () => {
  it("accepts absolute http(s) bases only", () => {
    expect(normalizeBase("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(normalizeBase("https://engine.example/paradox/")).toBe("https://engine.example/paradox");
    expect(normalizeBase("ftp://x")).toBeNull();
    expect(normalizeBase("http://user:pw@host")).toBeNull();
    expect(normalizeBase("http://host/?q=1")).toBeNull();
    expect(normalizeBase("not a url")).toBeNull();
  });
});
