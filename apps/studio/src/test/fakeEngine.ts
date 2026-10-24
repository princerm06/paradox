/**
 * Test-only contract fixture for the Paradox engine HTTP API. Payload shapes are
 * copied from the live engine (docs/api-contract.md, docs/contracts/m2-generation.md,
 * and responses observed from the shared backend on 2026-10-24). It is installed
 * as `fetch` in tests only; the product never substitutes fixtures.
 */
import type { Generation, Timeline } from "../api/types.ts";

export type Call = { method: string; path: string; body: unknown; auth?: string };
type Responder = (call: Call) => Response | Promise<Response> | undefined;

const ROOT = "11111111-0000-0000-0000-000000000001";
const POPULAR = "22222222-0000-0000-0000-000000000002";
const AI = "33333333-0000-0000-0000-000000000003";
const GEN_AI = "aaaaaaaa-0000-0000-0000-00000000000a";
const GEN_FAILED = "bbbbbbbb-0000-0000-0000-00000000000b";

export const IDS = { ROOT, POPULAR, AI, GEN_AI, GEN_FAILED };

export const DIFF_AI = `--- a/demo_app/ranking.py
+++ b/demo_app/ranking.py
@@ -1,5 +1,5 @@
-ORDERING = "chronological"
+ORDERING = "popular"


 def rank(posts: list[dict]) -> list[dict]:
-    return sorted(posts, key=lambda post: (post["created_at"], post["id"]), reverse=True)
+    return sorted(posts, key=lambda post: (post["likes"], post["created_at"], post["id"]), reverse=True)
--- /dev/null
+++ b/demo_app/tests/test_generated_popular_feed.py
@@ -0,0 +1,3 @@
+from demo_app import ranking
+
+def test_popular(): assert ranking.ORDERING == "popular"
`;

export function timeline(over: Partial<Timeline> & { id: string; name: string }): Timeline {
  return {
    parent_id: ROOT,
    status: "confirmed",
    created_at: "2026-10-24T00:20:00+00:00",
    snapshot_id: `snap-${over.id.slice(0, 4)}`,
    modification: "none",
    is_active: false,
    generation_id: null,
    ...over,
  };
}

export function generation(over: Partial<Generation> & { id: string }): Generation {
  return {
    parent_id: ROOT,
    name: "Popularity (AI)",
    prompt: "Rank the feed by popularity",
    provider: "scripted",
    status: "succeeded",
    timeline_id: null,
    base_snapshot_id: "snap-1111",
    activate_on_success: false,
    created_at: "2026-10-24T01:00:00+00:00",
    updated_at: "2026-10-24T01:01:10+00:00",
    finished_at: "2026-10-24T01:01:10+00:00",
    agent: { exit_code: 0, session_id: null, duration_ms: 2, summary: "Replaced chronological ranking with likes-descending.", usage: null },
    changes: {
      files: [
        { path: "demo_app/ranking.py", status: "modified", additions: 2, deletions: 2 },
        { path: "demo_app/tests/test_generated_popular_feed.py", status: "added", additions: 3, deletions: 0 },
      ],
    },
    evaluation: {
      passed: true,
      checks: [
        { name: "agent", status: "passed", duration_ms: 3, detail: null },
        { name: "guard", status: "passed", duration_ms: 2, detail: null },
        { name: "compile", status: "passed", duration_ms: 107, detail: null },
        { name: "tests", status: "passed", duration_ms: 215, detail: "1 passed" },
        { name: "boot", status: "passed", duration_ms: 283, detail: null },
        { name: "smoke", status: "passed", duration_ms: 15, detail: "GET /health 200, GET /api/posts 200" },
      ],
      tests: { passed: 1, failed: 0, errors: 0 },
      boot_ms: 283,
    },
    error: null,
    ...over,
  };
}

export class FakeEngine {
  timelines: Timeline[];
  activeId: string;
  generations: Generation[];
  diffs: Record<string, string> = {};
  calls: Call[] = [];
  offline = false;
  providers = [
    { id: "droid", available: false, reason: "Droid SDK adapter is not built" },
    { id: "scripted", available: true, reason: null },
    { id: "claude", available: false, reason: "optional Claude provider is not enabled" },
  ];
  /** Per-route overrides; return undefined to fall through to the default handler. */
  overrides: Responder[] = [];

  constructor() {
    this.timelines = [
      timeline({ id: ROOT, name: "Original", parent_id: null, modification: null, created_at: "2026-10-24T00:17:18+00:00", snapshot_id: "snap-1111" }),
      timeline({ id: POPULAR, name: "Popular feed", modification: "popular_feed", created_at: "2026-10-24T00:36:21+00:00" }),
      timeline({ id: AI, name: "UI popular", modification: "ai", status: "pending", generation_id: GEN_AI, created_at: "2026-10-24T02:02:01+00:00" }),
    ];
    this.activeId = POPULAR;
    this.generations = [
      generation({ id: GEN_AI, name: "UI popular", timeline_id: AI }),
      generation({
        id: GEN_FAILED,
        name: "Broken UI",
        prompt: "break the app",
        status: "failed",
        created_at: "2026-10-24T01:30:00+00:00",
        updated_at: "2026-10-24T01:30:02+00:00",
        changes: { files: [{ path: "demo_app/ranking.py", status: "modified", additions: 2, deletions: 2 }] },
        evaluation: {
          passed: false,
          checks: [
            { name: "agent", status: "passed", duration_ms: 1, detail: null },
            { name: "guard", status: "passed", duration_ms: 1, detail: null },
            { name: "compile", status: "failed", duration_ms: 110, detail: "Python compilation failed; inspect validation logs" },
          ],
          tests: null,
          boot_ms: null,
        },
        error: { stage: "compile", message: "Python compilation failed; inspect validation logs" },
      }),
    ];
    this.diffs[GEN_AI] = DIFF_AI;
    this.diffs[GEN_FAILED] = "--- a/demo_app/ranking.py\n+++ b/demo_app/ranking.py\n@@ -1,2 +1,2 @@\n-def rank(posts):\n+def rank(posts)\n";
  }

  view(): Timeline[] {
    return this.timelines.map((item) => ({ ...item, is_active: item.id === this.activeId }));
  }

  mutations(): Call[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    const call: Call = { method, path: url.pathname + url.search, body, auth: headers.get("Authorization") ?? undefined };
    this.calls.push(call);
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.offline) throw new TypeError("Failed to fetch");
    for (const override of this.overrides) {
      const result = await override(call);
      if (result) return result;
    }
    return this.route(call, url);
  };

  route(call: Call, url: URL): Response {
    const path = url.pathname;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/health") return json({ status: "ok", active_timeline_id: this.activeId, runtime_running: true });
    if (path === "/api/timelines" && call.method === "GET") return json({ timelines: this.view(), active_timeline_id: this.activeId, app_url: "http://127.0.0.1:8000/app/" });
    if (path === "/api/agents") return json({ default: "scripted", providers: this.providers });
    if (path === "/api/generations" && call.method === "GET") return json({ generations: [...this.generations].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
    if (path === "/openapi.json") return json({ openapi: "3.1.0", info: { title: "Paradox Timeline Engine", version: "0.1.0" }, paths: {} });
    let match = /^\/api\/timelines\/([^/]+)\/(activate|confirm|decline|snapshots|restore)$/.exec(path);
    if (match) {
      const [, id, action] = match;
      const found = this.timelines.find((item) => item.id === id);
      if (!found) return json({ detail: "Timeline not found" }, 404);
      if (action === "snapshots" && call.method === "GET") return json({ snapshots: [{ id: found.snapshot_id, timeline_id: id, created_at: "2026-10-24T02:00:00+00:00" }] });
      if (action === "activate") this.activeId = id;
      if (action === "confirm") found.status = "confirmed";
      if (action === "decline") found.status = "declined";
      return json({ ...found, is_active: found.id === this.activeId });
    }
    match = /^\/api\/generations\/([^/]+)(\/logs|\/diff|\/cancel)?$/.exec(path);
    if (match) {
      const [, id, suffix] = match;
      const found = this.generations.find((item) => item.id === id);
      if (!found) return json({ detail: "Generation not found" }, 404);
      if (suffix === "/diff") return new Response(this.diffs[id] ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
      if (suffix === "/logs") {
        const stream = url.searchParams.get("stream") ?? "agent";
        return json({ stream, lines: stream === "agent" ? ["Scripted recipe selected"] : ["agent: passed", "compile: failed"] });
      }
      if (suffix === "/cancel") {
        if (["succeeded", "failed", "cancelled"].includes(found.status)) return json({ detail: "Generation is already terminal" }, 409);
        found.status = "cancelled";
        found.error = { stage: "agent", message: "Cancelled by user" };
        found.updated_at = new Date().toISOString();
        return json(found);
      }
      return json(found);
    }
    if (path === "/api/generations" && call.method === "POST") {
      const input = call.body as { parent_id: string; prompt: string; name?: string; provider: string; activate_on_success: boolean };
      const created = generation({
        id: `cccccccc-0000-0000-0000-${String(this.generations.length).padStart(12, "0")}`,
        parent_id: input.parent_id,
        name: input.name ?? input.prompt.slice(0, 60),
        prompt: input.prompt,
        provider: input.provider,
        status: "queued",
        activate_on_success: input.activate_on_success,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        finished_at: null,
        agent: null,
        changes: null,
        evaluation: null,
        base_snapshot_id: null,
      });
      this.generations.push(created);
      return json(created, 202);
    }
    return json({ detail: "Not Found" }, 404);
  }
}

/** Route `fetch` to one fake engine per origin; unknown origins are unreachable. */
export function multiEngineFetch(engines: Record<string, FakeEngine>) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const engine = engines[url.origin];
    if (!engine) return Promise.reject(new TypeError("Failed to fetch"));
    return engine.fetch(input, init);
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
