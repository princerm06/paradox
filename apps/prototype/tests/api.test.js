import assert from "node:assert/strict";
import test from "node:test";
import { api, API_BASE, ApiError, formatDetail, setToken } from "../api.js";

test("every engine wrapper uses the backend path, method, and body contract", async () => {
  const cases = [
    [() => api.health(), "/api/health", "GET"],
    [() => api.timelines(), "/api/timelines", "GET"],
    [() => api.agents(), "/api/agents", "GET"],
    [() => api.sprout({ name: "Fork", modification: "none", parentId: "root" }), "/api/timelines/sprout", "POST", { name: "Fork", modification: "none", parent_id: "root" }],
    [() => api.activate("child"), "/api/timelines/child/activate", "POST"],
    [() => api.confirm("child"), "/api/timelines/child/confirm", "POST"],
    [() => api.decline("child"), "/api/timelines/child/decline", "POST"],
    [() => api.snapshots("root"), "/api/timelines/root/snapshots", "GET"],
    [() => api.createSnapshot("root"), "/api/timelines/root/snapshots", "POST"],
    [() => api.restore("root", "snapshot"), "/api/timelines/root/restore", "POST", { snapshot_id: "snapshot" }],
    [() => api.generations(), "/api/generations", "GET"],
    [() => api.generations("parent/id"), "/api/generations?parent_id=parent%2Fid", "GET"],
    [() => api.generation("job/id"), "/api/generations/job%2Fid", "GET"],
    [() => api.createGeneration({ parentId: "root", prompt: "popular", provider: "scripted" }), "/api/generations", "POST", { parent_id: "root", prompt: "popular", provider: "scripted", activate_on_success: false }],
    [() => api.createGeneration({ parentId: "root", prompt: "popular", provider: "scripted", name: "AI fork", activateOnSuccess: true }), "/api/generations", "POST", { parent_id: "root", prompt: "popular", provider: "scripted", name: "AI fork", activate_on_success: true }],
    [() => api.cancelGeneration("job"), "/api/generations/job/cancel", "POST"],
    [() => api.generationLogs("job", "validation", 2000), "/api/generations/job/logs?stream=validation&tail=2000", "GET"],
    [() => api.generationDiff("job"), "/api/generations/job/diff", "GET"],
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const [invoke, path, method, body] of cases) {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, API_BASE + path);
        assert.equal(options.method, method);
        assert.deepEqual(options.body === undefined ? undefined : JSON.parse(options.body), body);
        assert.equal(options.cache, "no-store");
        return path.endsWith("/diff")
          ? new Response("--- a/file\n+++ b/file")
          : Response.json({ received: true }, { status: path === "/api/generations" && method === "POST" ? 202 : method === "POST" ? 201 : 200 });
      };
      const result = await invoke();
      if (path.endsWith("/diff")) assert.match(result, /--- a\/file/);
      else assert.equal(result.received, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mutation authentication, structured errors, offline errors, and aborts", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  try {
    setToken("test-token");
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers?.Authorization, options.method === "POST" ? "Bearer test-token" : undefined);
      return Response.json({ detail: "Missing or invalid token" }, { status: 401 });
    };
    await assert.rejects(api.activate("root"), (error) => error instanceof ApiError && error.status === 401);
    await assert.rejects(api.health(), /Unauthorized/);
    for (const status of [404, 409, 422, 503]) {
      globalThis.fetch = async () => Response.json({ detail: [{ loc: ["body", "prompt"], msg: "Invalid value" }] }, { status });
      await assert.rejects(api.createGeneration({}), (error) => error.status === status && /prompt: Invalid value/.test(error.message));
      await assert.rejects(api.generationDiff("job"), (error) => error.status === status && /prompt: Invalid value/.test(error.message));
    }
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(api.timelines(), (error) => error.status === 0);
    globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError"); };
    await assert.rejects(api.health(), (error) => error.name === "AbortError");
    assert.equal(formatDetail("Busy", 409), "Conflict: Busy");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.localStorage;
  }
});
