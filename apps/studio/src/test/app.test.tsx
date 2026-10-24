import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine, IDS, deferred, generation } from "./fakeEngine.ts";

let engine: FakeEngine;

beforeEach(() => {
  engine = new FakeEngine();
  vi.stubGlobal("fetch", engine.fetch);
});

async function boot() {
  render(<App />);
  await screen.findByText(/Live · Popular feed/);
}

async function openFutures() {
  fireEvent.click(screen.getAllByRole("button", { name: "Futures" })[0]);
  return screen.findByRole("complementary", { name: "Futures" });
}

async function inspectTimeline(name: string) {
  const panel = await openFutures();
  fireEvent.click(within(panel).getByText(name));
  fireEvent.click(within(document.querySelector(".topbar") as HTMLElement).getByRole("button", { name: "Inspect" }));
  return screen.findByRole("complementary", { name: "Future inspector" });
}

describe("selection and inspection never mutate the runtime", () => {
  it("selecting, inspecting every tab, and comparing sends no mutating request", async () => {
    await boot();
    const inspector = await inspectTimeline("UI popular");
    for (const tab of ["Diff", "Logs", "Tests", "Snapshots", "Overview"]) {
      fireEvent.click(within(inspector).getByRole("tab", { name: tab }));
    }
    await within(inspector).findByText("Agent summary");
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const a = await screen.findByLabelText("Future A");
    const b = screen.getByLabelText("Future B");
    fireEvent.change(a, { target: { value: `timeline:${IDS.ROOT}` } });
    fireEvent.change(b, { target: { value: `generation:${IDS.GEN_FAILED}` } });
    for (const tab of ["Validation", "Files", "Diffs", "Logs", "Summary"]) fireEvent.click(screen.getByRole("tab", { name: tab }));
    fireEvent.click(screen.getByRole("button", { name: "Architect" }));
    await screen.findByText("Timeline engine");
    expect(engine.mutations()).toEqual([]);
    expect(screen.getByText(/Live · Popular feed/)).toBeInTheDocument();
  });
});

describe("explicit runtime actions", () => {
  it("asks before activating, and Cancel sends nothing", async () => {
    await boot();
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("button", { name: "Make live" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("switches from Popular feed to UI popular");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(engine.mutations()).toEqual([]);
  });

  it("activates via the engine and shows live only after the engine reports it", async () => {
    await boot();
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("button", { name: "Make live" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch runtime" }));
    await screen.findByText(/Engine confirmed: UI popular is live/);
    expect(engine.mutations()).toEqual([{ method: "POST", path: `/api/timelines/${IDS.AI}/activate`, body: undefined }]);
    expect(screen.getByText(/Live · UI popular/)).toBeInTheDocument();
  });

  it("keeps the backend's active timeline when activation succeeds but the engine still reports the old one", async () => {
    await boot();
    // Engine answers 200 but its list still says Popular feed is active (e.g. rolled back).
    engine.overrides.push((call) => (call.path.endsWith("/activate") ? new Response(JSON.stringify({ id: IDS.AI }), { status: 200 }) : undefined));
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("button", { name: "Make live" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch runtime" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText(/Live · Popular feed/)).toBeInTheDocument();
  });

  it("shows the engine's error in the dialog and leaves the runtime unchanged", async () => {
    await boot();
    engine.overrides.push((call) =>
      call.path.endsWith("/activate") ? new Response(JSON.stringify({ detail: "Transition failed; previous timeline restored. Inspect runtime.log" }), { status: 503 }) : undefined,
    );
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("button", { name: "Make live" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch runtime" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Unavailable: Transition failed; previous timeline restored");
    expect(screen.getByText(/Live · Popular feed/)).toBeInTheDocument();
  });

  it("explains decline consequences for the live future", async () => {
    engine.activeId = IDS.AI;
    render(<App />);
    await screen.findByText(/Live · UI popular/);
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("switch the runtime back to Original");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(engine.mutations()).toEqual([]);
  });

  it("restores a snapshot only after confirmation", async () => {
    await boot();
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("tab", { name: "Snapshots" }));
    fireEvent.click(await within(inspector).findByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("saves Popular feed's current code and data");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore and go live" }));
    await waitFor(() => expect(engine.mutations()).toEqual([{ method: "POST", path: `/api/timelines/${IDS.AI}/restore`, body: { snapshot_id: "snap-3333" } }]));
  });
});

describe("evidence loading", () => {
  it("does not show a slow diff from a previous selection under the new one", async () => {
    const slow = deferred<Response>();
    engine.generations.push(generation({ id: "dddddddd-0000-0000-0000-00000000000d", name: "Other attempt", status: "failed", error: { stage: "tests", message: "x" } }));
    engine.diffs["dddddddd-0000-0000-0000-00000000000d"] = "--- a/demo_app/other.py\n+++ b/demo_app/other.py\n@@ -1 +1 @@\n-a\n+b\n";
    engine.overrides.push((call) => (call.path === `/api/generations/${IDS.GEN_AI}/diff` ? slow.promise : undefined));
    await boot();
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("tab", { name: "Diff" }));
    await within(inspector).findByText("Loading the diff");
    const panel = await openFutures();
    fireEvent.click(within(panel).getByText("Other attempt"));
    await within(inspector).findByText("demo_app/other.py");
    await act(async () => {
      slow.resolve(new Response("--- a/demo_app/ranking.py\n+++ b/demo_app/ranking.py\n@@ -1 +1 @@\n-x\n+y\n", { status: 200 }));
      await Promise.resolve();
    });
    expect(within(inspector).queryByText("demo_app/ranking.py")).not.toBeInTheDocument();
    expect(within(inspector).getByText("demo_app/other.py")).toBeInTheDocument();
  });

  it("keeps logs usable when the diff fails", async () => {
    engine.overrides.push((call) => (call.path.endsWith("/diff") ? new Response(JSON.stringify({ detail: "diff missing" }), { status: 404 }) : undefined));
    await boot();
    const inspector = await inspectTimeline("UI popular");
    fireEvent.click(within(inspector).getByRole("tab", { name: "Diff" }));
    expect(await within(inspector).findByText("Not found: diff missing")).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("tab", { name: "Logs" }));
    expect(await within(inspector).findByText(/Scripted recipe selected/)).toBeInTheDocument();
  });

  it("explains that sprouts and roots have no generation evidence", async () => {
    await boot();
    const inspector = await inspectTimeline("Popular feed");
    fireEvent.click(within(inspector).getByRole("tab", { name: "Diff" }));
    expect(within(inspector).getByText(/Created by an engine sprout \(Popular feed\)/)).toBeInTheDocument();
  });
});

describe("generation lifecycle", () => {
  it("submits with activation off by default and follows real statuses to a timeline", async () => {
    await boot();
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "Rank the feed by popularity" } });
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(engine.mutations().length).toBe(1));
    const post = engine.mutations()[0];
    expect(post).toMatchObject({ method: "POST", path: "/api/generations" });
    expect(post.body).toMatchObject({ parent_id: IDS.POPULAR, provider: "scripted", activate_on_success: false });
    const created = engine.generations[engine.generations.length - 1];
    await screen.findByText("Queued", { selector: ".submission-head .fine" });
    act(() => {
      created.status = "generating";
      created.updated_at = new Date(Date.now() + 1000).toISOString();
    });
    await screen.findByText("Generating", { selector: ".submission-head .fine" }, { timeout: 3000 });
    act(() => {
      engine.timelines.push({ ...engine.timelines[2], id: "eeeeeeee-0000-0000-0000-00000000000e", name: "Rank the feed by popularity", generation_id: created.id });
      created.status = "succeeded";
      created.timeline_id = "eeeeeeee-0000-0000-0000-00000000000e";
      created.updated_at = new Date(Date.now() + 2000).toISOString();
    });
    await screen.findByText(/The new future is pending/, undefined, { timeout: 3000 });
    // Success never implies activation.
    expect(screen.getByText(/Live · Popular feed/)).toBeInTheDocument();
    expect(engine.mutations().length).toBe(1);
  });

  it("requires an explicit choice to go live and warns about it", async () => {
    await boot();
    fireEvent.click(screen.getByLabelText("Go live on success"));
    expect(screen.getByText(/switches the running app to this future without asking again/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "popular" } });
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    fireEvent.click(screen.getByRole("button", { name: /Generate & go live/ }));
    await waitFor(() => expect(engine.mutations()[0]?.body).toMatchObject({ activate_on_success: true }));
    // Resets to the safe default after submitting.
    await waitFor(() => expect(screen.getByLabelText("Keep live")).toBeChecked());
  });

  it("blocks submission when no provider is available and sends nothing", async () => {
    engine.providers = engine.providers.map((item) => ({ ...item, available: false, reason: item.reason ?? "disabled" }));
    await boot();
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "popular" } });
    await screen.findByText("None available");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    expect(await screen.findByText("No agent provider is available on this engine.")).toBeInTheDocument();
    expect(engine.mutations()).toEqual([]);
  });

  it("shows cancellation only from the engine's response, and a 409 as an error", async () => {
    const running = generation({ id: "ffffffff-0000-0000-0000-00000000000f", name: "Slow UI", status: "generating", timeline_id: null, finished_at: null, evaluation: null, changes: null });
    engine.generations.push(running);
    let reject = true;
    engine.overrides.push((call) => {
      if (!call.path.endsWith("/cancel") || !reject) return undefined;
      // The run finished before the cancel landed.
      running.status = "failed";
      running.error = { stage: "tests", message: "1 failed" };
      running.updated_at = new Date(Date.now() + 5000).toISOString();
      return new Response(JSON.stringify({ detail: "Generation is already terminal" }), { status: 409 });
    });
    await boot();
    const panel = await openFutures();
    fireEvent.click(within(panel).getByText("Slow UI"));
    fireEvent.click(within(document.querySelector(".topbar") as HTMLElement).getByRole("button", { name: "Inspect" }));
    const inspector = await screen.findByRole("complementary", { name: "Future inspector" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Cancel generation" }));
    await waitFor(() => expect(within(inspector).getAllByText(/Failed · tests/).length).toBeGreaterThan(0));
    expect(within(inspector).queryByText(/Cancelled/)).not.toBeInTheDocument();
    reject = false;
  });

  it("renders an unrecognised status as unknown, never as running", async () => {
    engine.generations.push(generation({ id: "99999999-0000-0000-0000-000000000009", name: "Mystery", status: "paused", timeline_id: null }));
    await boot();
    const panel = await openFutures();
    fireEvent.click(within(panel).getByText("Mystery"));
    fireEvent.click(within(document.querySelector(".topbar") as HTMLElement).getByRole("button", { name: "Inspect" }));
    const inspector = await screen.findByRole("complementary", { name: "Future inspector" });
    expect(within(inspector).getByText(/does not recognise/)).toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: "Cancel generation" })).not.toBeInTheDocument();
    expect(screen.queryByText(/1 generating/)).not.toBeInTheDocument();
  });
});

describe("offline and first run", () => {
  it("explains how to start the engine when it is unreachable", async () => {
    engine.offline = true;
    render(<App />);
    expect(await screen.findByText("Paradox can't reach its timeline engine")).toBeInTheDocument();
    expect(screen.getByText(/python -m engine/)).toBeInTheDocument();
    engine.offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Live · Popular feed/);
    expect(screen.queryByText("Paradox can't reach its timeline engine")).not.toBeInTheDocument();
  });

  it("disables runtime actions while offline", async () => {
    await boot();
    const inspector = await inspectTimeline("UI popular");
    engine.offline = true;
    await waitFor(() => expect(within(inspector).getByRole("button", { name: "Make live" })).toBeDisabled(), { timeout: 7000 });
    expect(within(inspector).getByText("Engine offline.")).toBeInTheDocument();
  });
});
