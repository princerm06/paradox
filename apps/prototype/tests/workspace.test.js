import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8")
  .replace(/^import .*;$/m, "")
  .replace(/boot\(\);\s*$/, "");

function workspace(overrides = {}) {
  const api = {
    generation: async () => generation(),
    snapshots: async () => ({ snapshots: [] }),
    health: async () => ({ status: "ok" }),
    generationLogs: async () => ({ lines: ["log line"] }),
    generationDiff: async () => "diff content",
    ...overrides,
  };
  const context = vm.createContext({
    api,
    ResizeObserver: class { observe() {} },
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    document: { getElementById: () => null },
    notices: [],
  });
  vm.runInContext(source + `
    renderNow = () => {};
    renderInspector = () => {};
    note = (...args) => notices.push(args);
    toast = () => {};
    globalThis.workspace = {
      state, upsertGeneration, reconcileGeneration, refreshGenerations, refreshTimelines,
      ensureInspection, cancelGeneration, ensureSnapshot, invalidateSnapshots,
      applyTimelineList, createSnapshot, ghostNodes, submitComposer,
    };
  `, context);
  return { ...context.workspace, api, notices: context.notices };
}

function generation(status = "generating", fields = {}) {
  return { id: "job", parent_id: "root", name: "Future", status, updated_at: "2026-10-23T12:00:00Z", ...fields };
}

const root = { id: "root", name: "Original", snapshot_id: "head", status: "confirmed", is_active: true };
const child = { id: "child", name: "Future", snapshot_id: "child-head", generation_id: "job", status: "pending", is_active: false };
const timelineList = { timelines: [root, child], active_timeline_id: "root", app_url: "http://127.0.0.1:8000/app/" };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("stale GET and list responses cannot undo terminal cancellation", async () => {
  const view = workspace({ generations: async () => ({ generations: [generation()] }) });
  view.upsertGeneration(generation("cancelled", { updated_at: "2026-10-23T12:00:01Z" }));
  view.upsertGeneration(generation());
  await view.refreshGenerations({ quiet: true });
  assert.equal(view.state.generations[0].status, "cancelled");
  view.upsertGeneration(generation("generating", { updated_at: "2026-10-23T12:00:02Z" }));
  assert.equal(view.state.generations[0].status, "cancelled");
});

test("inspection can discover success and select its published timeline", async () => {
  const completed = generation("succeeded", { timeline_id: "child", updated_at: "2026-10-23T12:00:01Z" });
  const view = workspace({ generation: async () => completed, timelines: async () => timelineList });
  view.state.timelines = [root];
  view.state.selectedGenerationId = "job";
  view.upsertGeneration(generation());
  view.ensureInspection("job");
  await settle();
  assert.equal(view.state.selectedId, "child");
  assert.equal(view.state.selectedGenerationId, null);
  assert.equal(view.state.inspections.job.record.status, "succeeded");
  assert.equal(view.notices.length, 1);
});

test("list polling processes terminal transitions too", async () => {
  const completed = generation("succeeded", { timeline_id: "child", updated_at: "2026-10-23T12:00:01Z" });
  const view = workspace({ generations: async () => ({ generations: [completed] }), timelines: async () => timelineList, generation: async () => completed });
  view.state.timelines = [root];
  view.state.selectedGenerationId = "job";
  view.upsertGeneration(generation());
  await view.refreshGenerations({ quiet: true });
  assert.equal(view.state.selectedId, "child");
  assert.equal(view.state.generations[0].status, "succeeded");
});

test("success with an unavailable timeline list preserves its selected ghost", async () => {
  const view = workspace({ timelines: async () => { throw new Error("offline"); } });
  view.state.selectedGenerationId = "job";
  view.upsertGeneration(generation());
  await view.reconcileGeneration(generation("succeeded", { timeline_id: "child" }));
  assert.equal(view.state.selectedGenerationId, "job");
  assert.equal(view.ghostNodes().length, 1);
  view.api.timelines = async () => timelineList;
  await view.reconcileGeneration(view.state.generations[0]);
  assert.equal(view.state.selectedId, "child");
});

test("partial diagnostic failures preserve checks and successful logs and allow retry", async () => {
  const failed = generation("failed", { evaluation: { checks: [{ name: "compile", status: "failed" }] } });
  const view = workspace({
    generation: async () => failed,
    generationDiff: async () => { throw new Error("Unavailable"); },
  });
  view.upsertGeneration(generation());
  view.state.selectedGenerationId = "job";
  view.ensureInspection("job");
  await settle();
  assert.equal(view.state.inspections.job.record.status, "failed");
  assert.equal(view.state.inspections.job.agent.lines[0], "log line");
  assert.match(view.state.inspections.job.error, /Diff: Unavailable/);
  view.api.generationDiff = async () => "recovered diff";
  view.ensureInspection("job");
  await settle();
  assert.equal(view.state.inspections.job.diff, "recovered diff");
  assert.equal(view.state.inspections.job.error, null);
});

test("cancellation conflict reconciles a run that already finished", async () => {
  const view = workspace({
    cancelGeneration: async () => { throw Object.assign(new Error("Conflict"), { status: 409 }); },
    generation: async () => generation("failed", { updated_at: "2026-10-23T12:00:01Z" }),
  });
  view.upsertGeneration(generation());
  await view.cancelGeneration("job");
  assert.equal(view.state.generations[0].status, "failed");
});

test("snapshot fallback updates the owning timeline, never inserts a phantom", async () => {
  const view = workspace({
    createSnapshot: async () => ({ id: "new-snapshot", timeline_id: "root" }),
    timelines: async () => { throw new Error("offline"); },
  });
  view.state.timelines = [{ ...root }];
  view.state.activeTimelineId = "root";
  await view.createSnapshot("root");
  assert.equal(view.state.timelines.length, 1);
  assert.equal(view.state.timelines[0].id, "root");
  assert.equal(view.state.timelines[0].snapshot_id, "new-snapshot");
});

test("snapshot invalidation prevents pre-mutation responses from winning", async () => {
  const pending = [];
  const view = workspace({ snapshots: () => new Promise((resolve) => pending.push(resolve)) });
  view.ensureSnapshot("root");
  view.invalidateSnapshots();
  view.ensureSnapshot("root");
  pending[1]({ snapshots: [{ id: "new" }] });
  await settle();
  pending[0]({ snapshots: [{ id: "old" }] });
  await settle();
  assert.equal(view.state.snapshotsById.root[0].id, "new");
});

test("a changed backend snapshot head refreshes visible snapshot lists", async () => {
  const view = workspace({ snapshots: async () => ({ snapshots: [{ id: "new-head" }] }) });
  view.state.timelines = [{ ...root }];
  view.state.selectedId = "root";
  view.state.snapshotStatus.root = "ready";
  view.applyTimelineList({ ...timelineList, timelines: [{ ...root, snapshot_id: "new-head" }] });
  await settle();
  assert.equal(view.state.snapshotsById.root[0].id, "new-head");
});

test("failed snapshot requests stay stable until explicit retry", async () => {
  let requests = 0;
  const view = workspace({ snapshots: async () => { requests += 1; throw new Error("offline"); } });
  view.ensureSnapshot("root");
  await settle();
  view.ensureSnapshot("root");
  view.ensureSnapshot("root");
  await settle();
  assert.equal(requests, 1);
  view.ensureSnapshot("root", true);
  await settle();
  assert.equal(requests, 2);
});

test("completion overlapping an inspection fetches final diagnostics", async () => {
  let release;
  let requests = 0;
  const terminal = generation("failed", { updated_at: "2026-10-23T12:00:01Z" });
  const view = workspace({
    generation: () => {
      requests += 1;
      return requests === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(terminal);
    },
    generationDiff: async () => requests === 1 ? "" : "final diff",
  });
  view.upsertGeneration(generation());
  view.state.selectedGenerationId = "job";
  view.ensureInspection("job");
  await view.reconcileGeneration(terminal);
  release(generation());
  await settle();
  await settle();
  assert.equal(requests, 2);
  assert.equal(view.state.inspections.job.diff, "final diff");
  assert.equal(view.state.inspections.job.record.status, "failed");
});

test("pre-mutation timeline responses cannot overwrite post-mutation reads", async () => {
  let release;
  let requests = 0;
  const view = workspace({
    timelines: () => {
      requests += 1;
      return requests === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ ...timelineList, timelines: [{ ...root, snapshot_id: "new-snapshot" }] });
    },
    createSnapshot: async () => ({ id: "new-snapshot", timeline_id: "root" }),
  });
  view.state.timelines = [{ ...root }];
  view.state.activeTimelineId = "root";
  const oldRead = view.refreshTimelines({ quiet: true });
  await view.createSnapshot("root");
  release({ ...timelineList, timelines: [root] });
  await oldRead;
  assert.equal(view.state.timelines[0].snapshot_id, "new-snapshot");
});

test("sprouting while inspecting a ghost selects the created timeline", async () => {
  const view = workspace({ sprout: async () => child, timelines: async () => timelineList });
  view.state.timelines = [root];
  view.state.selectedGenerationId = "job";
  view.upsertGeneration(generation("cancelled"));
  view.state.composer.name = "New fork";
  view.state.composer.parentId = "root";
  await view.submitComposer({ preventDefault() {} });
  assert.equal(view.state.selectedGenerationId, null);
  assert.equal(view.state.selectedId, "child");
});
