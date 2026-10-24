import type { AgentList, ChangedFile, Health, OpenApiDoc, OpenApiOperation, OpenApiSchema, Timeline } from "../api/types.ts";
import { directoryOf, parseUnifiedDiff, type DiffFile } from "../lib/diff.ts";

/**
 * Architecture adapter. Paradox's engine has no architecture endpoint, so this
 * model is assembled from the sources that do exist, and every node and edge
 * records which one it came from:
 *  - observed:    a live engine response (health, agents, openapi, timelines, generation)
 *  - documented:  the frozen contracts in docs/api-contract.md and docs/contracts/m2-generation.md
 *  - inferred:    a relationship the studio derives (e.g. a changed path under demo_app/)
 *  - unavailable: something the reference designs show but no source provides
 * A richer backend source can be added as another input without changing the view.
 */
export type Prov = "observed" | "documented" | "inferred" | "unavailable";

export type ArchNode = {
  id: string;
  label: string;
  sub: string;
  kind: "client" | "service" | "proxy" | "runtime" | "store" | "worker" | "provider" | "check" | "seam" | "dir" | "file" | "endpoint-group";
  prov: Prov;
  source: string;
  x: number;
  y: number;
  tone?: "live" | "ok" | "warn" | "bad" | "modified" | "added" | "deleted" | "quiet";
  details: Array<[string, string]>;
  notes?: string[];
  /** Files from the selected future that touch this node (by inferred path mapping). */
  touched?: string[];
};

export type ArchEdge = { id: string; from: string; to: string; label?: string; prov: Prov; source: string; tone?: "live" | "change" | "quiet" };
export type ArchModel = { nodes: ArchNode[]; edges: ArchEdge[] };

export const DOCS = {
  m1: "docs/api-contract.md",
  m2: "docs/contracts/m2-generation.md",
};

export type SystemSources = {
  studioOrigin: string;
  apiBase: string;
  health: Health | null;
  connected: boolean;
  agents: AgentList | null;
  openapi: OpenApiDoc | null;
  timelines: Timeline[];
  activeTimeline: Timeline | null;
  appUrl: string;
  activeGenerations: number;
  /** Changed files of the selected future (observed), used for the overlay. */
  changedFiles: ChangedFile[];
};

function endpointCount(openapi: OpenApiDoc | null, prefix: string): number {
  if (!openapi?.paths) return 0;
  let count = 0;
  for (const [path, item] of Object.entries(openapi.paths)) {
    if (!path.startsWith(prefix)) continue;
    count += Object.keys(item).filter((method) => METHODS.includes(method)).length;
  }
  return count;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

export function buildSystemModel(src: SystemSources): ArchModel {
  const runtimeOn = Boolean(src.connected && src.health?.runtime_running);
  const demoFiles = src.changedFiles.filter((file) => file.path.startsWith("demo_app/"));
  const rankingTouched = src.changedFiles.filter((file) => file.path === "demo_app/ranking.py");
  const testFiles = src.changedFiles.filter((file) => file.path.startsWith("demo_app/tests/"));
  const apiCount = src.openapi ? endpointCount(src.openapi, "/api/") : 0;
  const nodes: ArchNode[] = [
    {
      id: "studio",
      label: "Paradox Studio",
      sub: "React · this browser",
      kind: "client",
      prov: "observed",
      source: "window.location",
      x: 9,
      y: 46,
      tone: "ok",
      details: [
        ["Origin", src.studioOrigin],
        ["Engine base", src.apiBase],
      ],
      notes: ["Reads timelines, generations, logs and diffs; sends runtime actions only on explicit user action."],
    },
    {
      id: "engine",
      label: "Timeline engine",
      sub: src.openapi?.info?.title ? `${src.openapi.info.title} ${src.openapi.info.version ?? ""}`.trim() : "FastAPI",
      kind: "service",
      prov: src.connected ? "observed" : "documented",
      source: src.connected ? "GET /api/health" : DOCS.m1,
      x: 33,
      y: 46,
      tone: !src.connected ? "bad" : src.health?.status === "ok" ? "ok" : "warn",
      details: [
        ["Health", src.connected ? src.health?.status ?? "unknown" : "unreachable"],
        ["Endpoints", src.openapi ? `${apiCount} under /api (OpenAPI)` : "Schema not loaded"],
        ["Mutations", "Serialised behind one gate"],
        ["Auth", "Bearer token on mutating calls when PARADOX_TOKEN is set"],
      ],
      notes: ["One worker. Mutations and proxied app traffic serialise behind a single gate (documented)."],
    },
    {
      id: "store",
      label: "Timeline store",
      sub: "SQLite · snapshots",
      kind: "store",
      prov: "documented",
      source: DOCS.m1,
      x: 33,
      y: 84,
      tone: "quiet",
      details: [
        ["Timelines", src.connected ? `${src.timelines.length} (observed)` : "Unknown"],
        ["Snapshots", "Immutable code + SQLite data per save"],
        ["Location", "PARADOX_STATE_DIR"],
      ],
    },
    {
      id: "proxy",
      label: "App proxy",
      sub: "/app/* → runtime",
      kind: "proxy",
      prov: src.appUrl ? "observed" : "documented",
      source: src.appUrl ? "GET /api/timelines · app_url" : DOCS.m1,
      x: 58,
      y: 18,
      tone: runtimeOn ? "live" : "quiet",
      details: [
        ["Public URL", src.appUrl || "Not reported"],
        ["Behaviour", "Strips /app, forwards under the gate"],
      ],
    },
    {
      id: "runtime",
      label: "Demo app runtime",
      sub: src.activeTimeline ? `Serving ${src.activeTimeline.name}` : "uvicorn demo_app.main:app",
      kind: "runtime",
      prov: src.connected ? "observed" : "documented",
      source: src.connected ? "GET /api/health · runtime_running" : DOCS.m1,
      x: 82,
      y: 18,
      tone: !src.connected ? "quiet" : runtimeOn ? "live" : "bad",
      details: [
        ["Running", src.connected ? (runtimeOn ? "Yes" : "No") : "Unknown"],
        ["Live future", src.activeTimeline?.name ?? "Unknown"],
        ["Process", "One loopback runtime, restarted on every switch"],
      ],
      touched: demoFiles.map((file) => file.path),
    },
    {
      id: "appdb",
      label: "App data",
      sub: "SQLite · app.sqlite3",
      kind: "store",
      prov: "documented",
      source: DOCS.m1,
      x: 82,
      y: 46,
      tone: "quiet",
      details: [
        ["Location", "workspace/state/app.sqlite3"],
        ["Snapshot", "Saved and restored with code on every switch"],
      ],
    },
    {
      id: "seam",
      label: "Ranking seam",
      sub: "demo_app/ranking.py",
      kind: "seam",
      prov: "documented",
      source: DOCS.m1,
      x: 58,
      y: 46,
      tone: rankingTouched.length ? "modified" : "quiet",
      details: [
        ["Contract", "ORDERING: str, rank(posts) -> list[dict]"],
        ["Baseline", "chronological"],
        ["Sprout template", "engine/templates/popular_ranking.py"],
      ],
      touched: rankingTouched.map((file) => file.path),
    },
    {
      id: "workers",
      label: "Generation workers",
      sub: `2 slots · ${src.activeGenerations} in flight`,
      kind: "worker",
      prov: "documented",
      source: DOCS.m2,
      x: 58,
      y: 74,
      tone: src.activeGenerations ? "warn" : "quiet",
      details: [
        ["Concurrency", "Up to 2; extra requests queue"],
        ["In flight", `${src.activeGenerations} (observed from generation statuses)`],
        ["Workspace", "Copy of the parent's head snapshot"],
      ],
    },
    {
      id: "validation",
      label: "Validation",
      sub: "agent · guard · compile · tests · boot · smoke",
      kind: "check",
      prov: "documented",
      source: DOCS.m2,
      x: 82,
      y: 74,
      tone: testFiles.length ? "added" : "quiet",
      details: [
        ["Order", "agent → guard → compile → tests → boot → smoke"],
        ["Stops", "At the first failure"],
        ["Boot", "Throwaway runtime on a copy of the base state"],
      ],
      touched: testFiles.map((file) => file.path),
    },
  ];
  const providers = src.agents?.providers ?? [];
  providers.forEach((provider, index) => {
    nodes.push({
      id: `provider:${provider.id}`,
      label: provider.id,
      sub: provider.available ? (provider.id === src.agents?.default ? "available · default" : "available") : "unavailable",
      kind: "provider",
      prov: "observed",
      source: "GET /api/agents",
      x: 47 + index * 11,
      y: 94,
      tone: provider.available ? "ok" : "bad",
      details: [
        ["Available", provider.available ? "Yes" : "No"],
        ["Reason", provider.reason ?? "—"],
        ["Default", provider.id === src.agents?.default ? "Yes" : "No"],
      ],
    });
  });
  const edges: ArchEdge[] = [
    { id: "e1", from: "studio", to: "engine", label: "REST /api", prov: src.connected ? "observed" : "documented", source: src.connected ? "this session's requests" : DOCS.m1, tone: src.connected ? "live" : "quiet" },
    { id: "e2", from: "studio", to: "proxy", label: "iframe app_url", prov: src.appUrl ? "observed" : "documented", source: "app_url", tone: runtimeOn ? "live" : "quiet" },
    { id: "e3", from: "proxy", to: "runtime", label: "HTTP forward", prov: "documented", source: DOCS.m1, tone: runtimeOn ? "live" : "quiet" },
    { id: "e4", from: "engine", to: "store", label: "timelines · snapshots", prov: "documented", source: DOCS.m1 },
    { id: "e5", from: "engine", to: "runtime", label: "restore · restart", prov: "documented", source: DOCS.m1 },
    { id: "e6", from: "runtime", to: "appdb", prov: "documented", source: DOCS.m1 },
    { id: "e7", from: "runtime", to: "seam", prov: "documented", source: DOCS.m1, tone: rankingTouched.length ? "change" : "quiet" },
    { id: "e8", from: "engine", to: "workers", label: "POST /api/generations", prov: "documented", source: DOCS.m2 },
    { id: "e9", from: "workers", to: "validation", prov: "documented", source: DOCS.m2, tone: testFiles.length ? "change" : "quiet" },
  ];
  for (const provider of providers) {
    edges.push({ id: `ep:${provider.id}`, from: "workers", to: `provider:${provider.id}`, prov: "observed", source: "GET /api/agents", tone: provider.available ? "quiet" : "quiet" });
  }
  return { nodes, edges };
}

/* ---------------- Endpoints (OpenAPI) ---------------- */

export type Endpoint = {
  id: string;
  method: string;
  path: string;
  group: string;
  summary: string;
  operation: OpenApiOperation;
  mutating: boolean;
  usedByStudio: boolean;
};

/** Endpoints this studio calls (from src/api/client.ts), used to mark coverage. */
export const STUDIO_CALLS = new Set([
  "GET /api/health",
  "GET /api/timelines",
  "POST /api/timelines/{timeline_id}/activate",
  "POST /api/timelines/{timeline_id}/confirm",
  "POST /api/timelines/{timeline_id}/decline",
  "GET /api/timelines/{timeline_id}/snapshots",
  "POST /api/timelines/{timeline_id}/snapshots",
  "POST /api/timelines/{timeline_id}/restore",
  "GET /api/agents",
  "POST /api/generations",
  "GET /api/generations",
  "GET /api/generations/{generation_id}",
  "GET /api/generations/{generation_id}/logs",
  "GET /api/generations/{generation_id}/diff",
  "POST /api/generations/{generation_id}/cancel",
]);

export function endpointGroup(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? `/${parts[0]}/${parts[1]}` : path;
}

export function listEndpoints(openapi: OpenApiDoc | null): Endpoint[] {
  if (!openapi?.paths) return [];
  const result: Endpoint[] = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const verb = method.toUpperCase();
      result.push({
        id: `${verb} ${path}`,
        method: verb,
        path,
        group: endpointGroup(path),
        summary: operation.summary ?? operation.operationId ?? "",
        operation,
        mutating: verb !== "GET",
        usedByStudio: STUDIO_CALLS.has(`${verb} ${path}`),
      });
    }
  }
  return result.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export type SchemaField = { name: string; type: string; required: boolean };

export function resolveSchema(openapi: OpenApiDoc | null, schema: OpenApiSchema | undefined, depth = 0): OpenApiSchema | undefined {
  if (!schema || depth > 4) return schema;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? "";
    return resolveSchema(openapi, openapi?.components?.schemas?.[name], depth + 1);
  }
  return schema;
}

export function schemaName(schema: OpenApiSchema | undefined): string {
  if (!schema) return "—";
  if (schema.$ref) return schema.$ref.split("/").pop() ?? "object";
  if (schema.type === "array") return `${schemaName(schema.items)}[]`;
  if (schema.anyOf) return schema.anyOf.map(schemaName).join(" | ");
  return schema.title && schema.type === "object" ? schema.title : schema.type ?? "object";
}

export function schemaFields(openapi: OpenApiDoc | null, schema: OpenApiSchema | undefined): SchemaField[] {
  const resolved = resolveSchema(openapi, schema);
  if (!resolved?.properties) return [];
  const required = new Set(resolved.required ?? []);
  return Object.entries(resolved.properties).map(([name, value]) => ({
    name,
    type: value.enum ? value.enum.map(String).join(" | ") : schemaName(value),
    required: required.has(name),
  }));
}

/* ---------------- Changes (selected future files) ---------------- */

export type ChangeEntry = { path: string; dir: string; status: string; additions: number | null; deletions: number | null; diff: DiffFile | null; mapsTo: string | null };

/** Join the engine's per-file report with parsed diff hunks; flag paths that map onto documented boundaries. */
export function changeEntries(files: ChangedFile[], diffText: string | null): ChangeEntry[] {
  const parsed = diffText ? parseUnifiedDiff(diffText) : [];
  const byPath = new Map(parsed.map((file) => [file.path, file]));
  const paths = new Set<string>([...files.map((file) => file.path), ...parsed.map((file) => file.path)]);
  return [...paths].sort().map((path) => {
    const reported = files.find((file) => file.path === path);
    const diff = byPath.get(path) ?? null;
    return {
      path,
      dir: directoryOf(path) || ".",
      status: reported?.status ?? diff?.status ?? "modified",
      additions: reported?.additions ?? diff?.additions ?? null,
      deletions: reported?.deletions ?? diff?.deletions ?? null,
      diff,
      mapsTo: path === "demo_app/ranking.py" ? "seam" : path.startsWith("demo_app/tests/") ? "validation" : path.startsWith("demo_app/") ? "runtime" : null,
    };
  });
}
