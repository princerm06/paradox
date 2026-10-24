import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { api } from "../api.js";

async function finished(id) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const record = await api.generation(id);
    if (["succeeded", "failed", "cancelled"].includes(record.status)) return record;
    await delay(100);
  }
  throw new Error(`Generation ${id} did not finish`);
}

test("real backend: every frontend operation and scripted lifecycle", { skip: process.env.PARADOX_UI_LIVE !== "1", timeout: 90000 }, async () => {
  assert.equal((await api.health()).runtime_running, true);
  const initial = await api.timelines();
  const root = initial.active_timeline_id;
  assert.ok((await api.agents()).providers.some((provider) => provider.id === "scripted" && provider.available));
  const snapshot = await api.createSnapshot(root);
  assert.equal(snapshot.timeline_id, root);
  assert.ok((await api.snapshots(root)).snapshots.some((item) => item.id === snapshot.id));

  const queued = await api.createGeneration({ parentId: root, prompt: "popular", provider: "scripted", name: "Node verified popular" });
  assert.equal(queued.status, "queued");
  const success = await finished(queued.id);
  assert.equal(success.status, "succeeded");
  assert.equal(success.evaluation.passed, true);
  assert.ok(success.changes.files.some((file) => file.path === "demo_app/ranking.py"));
  assert.match(await api.generationDiff(success.id), /ranking.py/);
  assert.ok((await api.generationLogs(success.id, "agent")).lines.length);
  assert.ok((await api.generationLogs(success.id, "validation")).lines.length);
  assert.ok((await api.generations(root)).generations.some((item) => item.id === success.id));
  assert.equal((await api.timelines()).active_timeline_id, root);
  assert.equal((await api.activate(success.timeline_id)).is_active, true);
  const feed = await fetch(new URL("api/posts", initial.app_url)).then((response) => response.json());
  assert.equal(feed.ordering, "popular");
  assert.equal((await api.confirm(success.timeline_id)).status, "confirmed");
  await api.restore(root, snapshot.id);
  const restoredFeed = await fetch(new URL("api/posts", initial.app_url)).then((response) => response.json());
  assert.equal(restoredFeed.ordering, "chronological");

  const bad = await api.createGeneration({ parentId: root, prompt: "break the app", provider: "scripted" });
  const failure = await finished(bad.id);
  assert.equal(failure.status, "failed");
  assert.equal(failure.error.stage, "compile");
  assert.equal(failure.timeline_id, null);
  const slow = await api.createGeneration({ parentId: root, prompt: "slow", provider: "scripted" });
  assert.equal((await api.cancelGeneration(slow.id)).status, "cancelled");
  assert.equal((await finished(slow.id)).timeline_id, null);
  await assert.rejects(api.cancelGeneration(success.id), (error) => error.status === 409);

  const fork = await api.sprout({ name: "Node verified fork", modification: "none", parentId: root });
  assert.equal(fork.is_active, true);
  assert.equal((await api.decline(fork.id)).status, "declined");
  assert.equal((await api.timelines()).active_timeline_id, root);
  await assert.rejects(api.activate(fork.id), (error) => error.status === 409);
  await assert.rejects(api.generation("does-not-exist"), (error) => error.status === 404);
  await assert.rejects(api.createGeneration({ parentId: root, prompt: "", provider: "scripted" }), (error) => error.status === 422);
});
