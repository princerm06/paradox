import { describe, expect, it } from "vitest";
import openapi from "../test/fixtures/openapi.json";
import type { OpenApiDoc } from "../api/types.ts";
import { buildSystemModel, changeEntries, listEndpoints, schemaFields } from "./model.ts";
import { DIFF_AI } from "../test/fakeEngine.ts";

const doc = openapi as unknown as OpenApiDoc;

describe("architecture adapter", () => {
  const base = {
    studioOrigin: "http://localhost:5173",
    apiBase: "http://127.0.0.1:8000",
    timelines: [],
    activeTimeline: null,
    appUrl: "",
    activeGenerations: 0,
    changedFiles: [],
    openapi: null,
  };
  it("labels every node with provenance and drops to documented when offline", () => {
    const offline = buildSystemModel({ ...base, health: null, connected: false, agents: null });
    expect(offline.nodes.find((node) => node.id === "engine")?.prov).toBe("documented");
    expect(offline.nodes.find((node) => node.id === "runtime")?.prov).toBe("documented");
    expect(offline.nodes.some((node) => node.kind === "provider")).toBe(false);
    for (const node of offline.nodes) expect(["observed", "documented", "inferred", "unavailable"]).toContain(node.prov);
  });
  it("uses observed agent availability and maps changed files by path", () => {
    const model = buildSystemModel({
      ...base,
      health: { status: "ok", active_timeline_id: "x", runtime_running: true },
      connected: true,
      agents: { default: "scripted", providers: [{ id: "scripted", available: true, reason: null }, { id: "droid", available: false, reason: "not built" }] },
      changedFiles: [{ path: "demo_app/ranking.py", status: "modified", additions: 2, deletions: 2 }],
    });
    expect(model.nodes.find((node) => node.id === "provider:droid")).toMatchObject({ prov: "observed", tone: "bad" });
    expect(model.nodes.find((node) => node.id === "seam")?.touched).toEqual(["demo_app/ranking.py"]);
    expect(model.nodes.find((node) => node.id === "runtime")?.touched).toEqual(["demo_app/ranking.py"]);
  });
  it("lists endpoints from the engine's real OpenAPI schema and marks studio usage", () => {
    const endpoints = listEndpoints(doc);
    expect(endpoints.length).toBeGreaterThanOrEqual(15);
    const activate = endpoints.find((endpoint) => endpoint.id === "POST /api/timelines/{timeline_id}/activate");
    expect(activate).toMatchObject({ mutating: true, usedByStudio: true, group: "/api/timelines" });
    const sprout = endpoints.find((endpoint) => endpoint.id === "POST /api/timelines/sprout");
    expect(sprout?.usedByStudio).toBe(false);
    const create = endpoints.find((endpoint) => endpoint.id === "POST /api/generations")!;
    const fields = schemaFields(doc, create.operation.requestBody?.content?.["application/json"]?.schema);
    expect(fields.find((field) => field.name === "prompt")).toMatchObject({ required: true });
    expect(fields.find((field) => field.name === "activate_on_success")?.required).toBe(false);
  });
  it("joins reported files with diff hunks", () => {
    const entries = changeEntries([{ path: "demo_app/ranking.py", status: "modified", additions: 2, deletions: 2 }], DIFF_AI);
    expect(entries.map((entry) => entry.path)).toEqual(["demo_app/ranking.py", "demo_app/tests/test_generated_popular_feed.py"]);
    expect(entries[0]).toMatchObject({ mapsTo: "seam", additions: 2 });
    expect(entries[1]).toMatchObject({ mapsTo: "validation", status: "added" });
    expect(entries[0].diff?.hunks.length).toBe(1);
  });
});
