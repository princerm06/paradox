import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine, IDS, deferred, generation, multiEngineFetch } from "./fakeEngine.ts";

const A = "http://127.0.0.1:8000";
const B = "http://127.0.0.1:8010";

let a: FakeEngine;
let b: FakeEngine;

beforeEach(() => {
  a = new FakeEngine();
  b = new FakeEngine();
  // Same ids on purpose: only the engine identity tells the records apart.
  b.timelines = b.timelines.map((item) => ({ ...item, name: `Bee ${item.name}` }));
  b.generations = b.generations.map((item) => ({ ...item, name: `Bee ${item.name}` }));
  vi.stubGlobal("fetch", multiEngineFetch({ [A]: a, [B]: b }));
});

function topbar() {
  return within(document.querySelector(".topbar") as HTMLElement);
}

async function switchEngine(url: string) {
  fireEvent.click(topbar().getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Studio settings" });
  fireEvent.change(within(dialog).getByLabelText("Engine URL"), { target: { value: url } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Use" }));
}

async function saveToken(value: string) {
  fireEvent.click(topbar().getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Studio settings" });
  fireEvent.change(within(dialog).getByLabelText("Engine token"), { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  fireEvent.click(topbar().getByRole("button", { name: "Settings" }));
}

async function activateViaInspector(name: string) {
  fireEvent.click(topbar().getByRole("button", { name: "Futures" }));
  const panel = await screen.findByRole("complementary", { name: "Futures" });
  fireEvent.click(within(panel).getByText(name));
  fireEvent.click(topbar().getByRole("button", { name: "Inspect" }));
  const inspector = await screen.findByRole("complementary", { name: "Future inspector" });
  fireEvent.click(within(inspector).getByRole("button", { name: "Make live" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch runtime" }));
}

describe("engine identity", () => {
  it("replaces every engine-specific record when switching engines", async () => {
    render(<App />);
    await screen.findByText("Live · Popular feed");
    expect(document.documentElement.getAttribute("data-paradox-engine")).toBe(A);
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    expect(document.documentElement.getAttribute("data-paradox-engine")).toBe(B);
    fireEvent.click(topbar().getByRole("button", { name: "Futures" }));
    const panel = await screen.findByRole("complementary", { name: "Futures" });
    expect(within(panel).queryByText("UI popular")).not.toBeInTheDocument();
    expect(within(panel).getByText("Bee UI popular")).toBeInTheDocument();
    expect(a.mutations()).toEqual([]);
    expect(b.mutations()).toEqual([]);
  });

  it("drops slow responses from the previous engine instead of rendering them", async () => {
    const slowList = deferred<Response>();
    const slowAgents = deferred<Response>();
    a.overrides.push((call) => (call.path === "/api/timelines" ? slowList.promise : undefined));
    a.overrides.push((call) => (call.path === "/api/agents" ? slowAgents.promise : undefined));
    render(<App />);
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    const stale = new FakeEngine();
    await act(async () => {
      slowList.resolve(new Response(JSON.stringify({ timelines: stale.view(), active_timeline_id: IDS.ROOT, app_url: "http://127.0.0.1:8000/app/" }), { status: 200 }));
      slowAgents.resolve(new Response(JSON.stringify({ default: "droid", providers: [{ id: "droid", available: true, reason: null }] }), { status: 200 }));
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(screen.getByText("Live · Bee Popular feed")).toBeInTheDocument();
    expect(screen.queryByText("Live · Original")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted");
    expect(screen.queryByRole("option", { name: /droid · paid/ })).not.toBeInTheDocument();
  });

  it("survives rapid switching and settles on the last engine", async () => {
    render(<App />);
    await screen.findByText("Live · Popular feed");
    await switchEngine(B);
    await switchEngine(A);
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    expect(localStorage.getItem("paradox.apiBase")).toBe(B);
  });

  it("stops polling the previous engine's running generation and hides its controls", async () => {
    const running = generation({ id: "ffffffff-0000-0000-0000-00000000000f", name: "Slow on A", status: "generating", timeline_id: null, finished_at: null });
    a.generations.push(running);
    render(<App />);
    await screen.findByText("Slow on A", { selector: ".submission-head strong" });
    expect(within(document.querySelector(".submission") as HTMLElement).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    expect(screen.queryByText("Slow on A")).not.toBeInTheDocument();
    expect(document.querySelector(".submission")).toBeNull();
    const before = a.calls.length;
    await new Promise((done) => setTimeout(done, 1300));
    expect(a.calls.slice(before)).toEqual([]);
    expect(a.mutations()).toEqual([]);
  });
});

describe("engine credentials", () => {
  it("sends a token only to the engine it was saved for", async () => {
    render(<App />);
    await screen.findByText("Live · Popular feed");
    await saveToken("secret-for-a");
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    await activateViaInspector("Bee UI popular");
    await waitFor(() => expect(b.mutations().length).toBe(1));
    expect(b.mutations()[0].auth).toBeUndefined();
    expect(b.calls.every((call) => call.auth === undefined)).toBe(true);

    await switchEngine(A);
    await screen.findByText("Live · Popular feed");
    await activateViaInspector("UI popular");
    await waitFor(() => expect(a.mutations().length).toBe(1));
    expect(a.mutations()[0].auth).toBe("Bearer secret-for-a");
  });

  it("binds a token saved before scoping to the engine in use, never to the next one", async () => {
    localStorage.setItem("paradox.token", "legacy");
    render(<App />);
    await screen.findByText("Live · Popular feed");
    expect(localStorage.getItem("paradox.token")).toBeNull();
    await activateViaInspector("UI popular");
    await waitFor(() => expect(a.mutations().length).toBe(1));
    expect(a.mutations()[0].auth).toBe("Bearer legacy");
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    await activateViaInspector("Bee UI popular");
    await waitFor(() => expect(b.mutations().length).toBe(1));
    expect(b.mutations()[0].auth).toBeUndefined();
  });

  it("does not allow switching engines while a runtime action is in flight", async () => {
    const hold = deferred<Response>();
    a.overrides.push((call) => (call.path.endsWith("/activate") ? hold.promise : undefined));
    render(<App />);
    await screen.findByText("Live · Popular feed");
    await activateViaInspector("UI popular");
    fireEvent.click(topbar().getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Studio settings" });
    fireEvent.change(within(dialog).getByLabelText("Engine URL"), { target: { value: B } });
    expect(within(dialog).getByRole("button", { name: "Use" })).toBeDisabled();
    expect(dialog).toHaveTextContent("Wait for the current runtime action to finish");
    await act(async () => {
      hold.resolve(new Response(JSON.stringify({ id: IDS.AI }), { status: 200 }));
      await Promise.resolve();
    });
  });
});

describe("cost-safe generation", () => {
  it("starts on the free scripted provider even when the engine defaults to a paid one", async () => {
    a.providers = a.providers.map((item) => (item.id === "droid" ? { ...item, available: true, reason: null } : item));
    a.overrides.push((call) => (call.path === "/api/agents" ? new Response(JSON.stringify({ default: "droid", providers: a.providers }), { status: 200 }) : undefined));
    render(<App />);
    await screen.findByText("Live · Popular feed");
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "popular" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(a.mutations().length).toBe(1));
    expect(a.mutations()[0]).toMatchObject({ method: "POST", path: "/api/generations", body: { provider: "scripted" } });
  });

  it("asks before running a paid provider and sends nothing when declined", async () => {
    a.providers = a.providers.map((item) => (item.id === "droid" ? { ...item, available: true, reason: null } : item));
    render(<App />);
    await screen.findByText("Live · Popular feed");
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    fireEvent.change(screen.getByLabelText("Agent provider"), { target: { value: "droid" } });
    expect(screen.getByText(/droid may consume paid agent credits/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "popular" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Run a paid droid generation?");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(a.mutations()).toEqual([]);
    // A deliberate choice is still possible after confirming.
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Generate with droid" }));
    await waitFor(() => expect(a.mutations().length).toBe(1));
    expect(a.mutations()[0].body).toMatchObject({ provider: "droid" });
  });
});

describe("refresh recovery", () => {
  it("reattaches a running generation after reload without resubmitting it", async () => {
    const first = render(<App />);
    await screen.findByText("Live · Popular feed");
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "slow rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await screen.findByText("Queued", { selector: ".submission-head .fine" });
    const created = a.generations[a.generations.length - 1];
    created.status = "generating";
    created.updated_at = new Date(Date.now() + 1000).toISOString();
    fireEvent.click(within(document.querySelector(".submission") as HTMLElement).getByRole("button", { name: "Inspect" }));
    await screen.findByRole("complementary", { name: "Future inspector" });
    first.unmount();

    // "Refresh": same tab session storage, fresh React tree.
    render(<App />);
    await screen.findByText("slow rehearsal", { selector: ".submission-head strong" });
    await screen.findByText("Generating", { selector: ".submission-head .fine" });
    expect(screen.getByText(/Restored after reload/)).toBeInTheDocument();
    const inspector = await screen.findByRole("complementary", { name: "Future inspector" });
    expect(within(inspector).getByRole("heading", { name: "slow rehearsal" })).toBeInTheDocument();
    expect(within(document.querySelector(".submission") as HTMLElement).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(a.mutations().filter((call) => call.path === "/api/generations")).toHaveLength(1);
    // One ghost for the one record.
    expect(document.querySelectorAll(`[data-id="generation:${created.id}"]`).length).toBeLessThanOrEqual(1);
  });

  it("surfaces a generation another session started, labelled as reattached", async () => {
    a.generations.push(generation({ id: "ffffffff-0000-0000-0000-00000000000f", name: "Started elsewhere", status: "validating", timeline_id: null, finished_at: null }));
    render(<App />);
    await screen.findByText("Started elsewhere", { selector: ".submission-head strong" });
    expect(screen.getByText(/Reattached after reload; it may have been started by another tab or client\. Nothing was resubmitted/)).toBeInTheDocument();
    expect(a.mutations()).toEqual([]);
  });

  it("never restores one engine's inspection context on another", async () => {
    const first = render(<App />);
    await screen.findByText("Live · Popular feed");
    fireEvent.click(topbar().getByRole("button", { name: "Futures" }));
    fireEvent.click(within(await screen.findByRole("complementary", { name: "Futures" })).getByText("Broken UI"));
    first.unmount();
    localStorage.setItem("paradox.apiBase", B);
    render(<App />);
    await screen.findByText("Live · Bee Popular feed");
    fireEvent.click(topbar().getByRole("button", { name: "Inspect" }));
    const inspector = await screen.findByRole("complementary", { name: "Future inspector" });
    expect(within(inspector).queryByText(/Broken UI/)).not.toBeInTheDocument();
  });
});
