import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { initialProvider } from "../lib/providers.ts";
import { FakeEngine, IDS, multiEngineFetch } from "./fakeEngine.ts";

const A = "http://127.0.0.1:8000";
const B = "http://127.0.0.1:8010";

let a: FakeEngine;
let b: FakeEngine;

beforeEach(() => {
  a = new FakeEngine();
  b = new FakeEngine();
  b.timelines = b.timelines.map((item) => ({ ...item, name: `Bee ${item.name}` }));
  b.generations = b.generations.map((item) => ({ ...item, name: `Bee ${item.name}` }));
  vi.stubGlobal("fetch", multiEngineFetch({ [A]: a, [B]: b }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function topbar() {
  return within(document.querySelector(".topbar") as HTMLElement);
}

function droidDefault(engine: FakeEngine, scripted: boolean) {
  engine.providers = engine.providers.map((item) =>
    item.id === "droid" ? { ...item, available: true, reason: null } : item.id === "scripted" ? { ...item, available: scripted, reason: scripted ? null : "scripted recipes are not configured" } : item,
  );
  engine.overrides.push((call) => (call.path === "/api/agents" ? new Response(JSON.stringify({ default: "droid", providers: engine.providers }), { status: 200 }) : undefined));
}

const posts = (engine: FakeEngine) => engine.mutations().filter((call) => call.method === "POST" && call.path === "/api/generations");
const nonGenerationMutations = (engine: FakeEngine) => engine.mutations().filter((call) => call.path !== "/api/generations");

async function boot(live = "Live · Popular feed") {
  const view = render(<App />);
  await screen.findByText(live);
  await waitFor(() => expect(screen.queryByText("Checking agents…")).not.toBeInTheDocument());
  return view;
}

function type(prompt: string) {
  fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: prompt } });
}

async function switchEngine(url: string) {
  fireEvent.click(topbar().getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Studio settings" });
  fireEvent.change(within(dialog).getByLabelText("Engine URL"), { target: { value: url } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Use" }));
}

async function selectInFutures(name: string) {
  const button = topbar().getByRole("button", { name: "Futures" });
  if (!screen.queryByRole("complementary", { name: "Futures" })) fireEvent.click(button);
  const panel = await screen.findByRole("complementary", { name: "Futures" });
  fireEvent.click(within(panel).getByText(name));
}

describe("A1: scripted provider by default in every build", () => {
  it("chooses scripted when available and nothing otherwise, never the engine default", () => {
    const providers = [
      { id: "droid", available: true, reason: null },
      { id: "scripted", available: true, reason: null },
    ];
    expect(initialProvider({ default: "droid", providers })).toBe("scripted");
    expect(initialProvider({ default: "droid", providers: providers.map((item) => (item.id === "scripted" ? { ...item, available: false } : item)) })).toBe("");
    expect(initialProvider({ default: "claude", providers: [{ id: "claude", available: true, reason: null }] })).toBe("");
  });

  it("starts on scripted in a production build whose engine defaults to droid, even with the old override set to 0", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_PARADOX_SAFE_PROVIDER", "0");
    droidDefault(a, true);
    await boot();
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    type("popular");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(posts(a)).toHaveLength(1));
    expect(posts(a)[0].body).toMatchObject({ provider: "scripted" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("requires an explicit paid choice and a confirmation when scripted is unavailable", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    droidDefault(a, false);
    await boot();
    const select = screen.getByLabelText("Agent provider");
    expect(await within(select).findByRole("option", { name: "Choose an agent" })).toBeInTheDocument();
    expect(select).toHaveValue("");
    type("popular");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    expect(await screen.findByText(/free scripted provider is not available on this engine. Choose an agent provider explicitly/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(a.mutations()).toEqual([]);

    fireEvent.change(select, { target: { value: "droid" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Run a paid droid generation?");
    expect(dialog).toHaveTextContent("is not available on this engine");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(a.mutations()).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText("What would you like to change?"), { key: "Enter", metaKey: true });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(a.mutations()).toEqual([]);
  });

  it("forgets a paid choice on refresh and on an engine switch", async () => {
    droidDefault(a, true);
    droidDefault(b, true);
    const first = await boot();
    fireEvent.change(screen.getByLabelText("Agent provider"), { target: { value: "droid" } });
    expect(screen.getByLabelText("Agent provider")).toHaveValue("droid");
    first.unmount();

    const second = await boot();
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    fireEvent.change(screen.getByLabelText("Agent provider"), { target: { value: "droid" } });
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
    second.unmount();

    localStorage.setItem("paradox.apiBase", B);
    droidDefault(b, false);
    await boot("Live · Bee Popular feed");
    expect(await within(screen.getByLabelText("Agent provider")).findByRole("option", { name: "Choose an agent" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agent provider")).toHaveValue("");
    expect(a.mutations()).toEqual([]);
    expect(b.mutations()).toEqual([]);
  });
});

describe("A2: the composer parent is independent of inspection", () => {
  it("defaults to the live future and ignores graph and inspector selection", async () => {
    await boot();
    const parent = screen.getByLabelText("Parent future");
    expect(parent).toHaveValue(IDS.POPULAR);
    expect(document.getElementById(parent.getAttribute("aria-describedby")!)).toHaveTextContent("live");
    await selectInFutures("Original");
    expect(parent).toHaveValue(IDS.POPULAR);
    await selectInFutures("Broken UI");
    fireEvent.click(topbar().getByRole("button", { name: "Inspect" }));
    await screen.findByRole("complementary", { name: "Future inspector" });
    expect(parent).toHaveValue(IDS.POPULAR);
    type("popular");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(posts(a)).toHaveLength(1));
    expect(posts(a)[0].body).toMatchObject({ parent_id: IDS.POPULAR });
    expect(nonGenerationMutations(a)).toEqual([]);
  });

  it("does not branch the next prompt from a generated child that was inspected", async () => {
    await boot();
    type("first child");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(posts(a)).toHaveLength(1));
    const created = a.generations[a.generations.length - 1];
    const child = "eeeeeeee-0000-0000-0000-00000000000e";
    act(() => {
      a.timelines.push({ ...a.timelines[2], id: child, name: "first child", generation_id: created.id });
      created.status = "succeeded";
      created.timeline_id = child;
      created.updated_at = new Date(Date.now() + 2000).toISOString();
    });
    await screen.findByText(/The new future is pending/, undefined, { timeout: 3000 });
    fireEvent.click(within(document.querySelector(".submission") as HTMLElement).getByRole("button", { name: "Inspect" }));
    const inspector = await screen.findByRole("complementary", { name: "Future inspector" });
    expect(within(inspector).getByRole("heading", { name: "first child" })).toBeInTheDocument();
    expect(screen.getByLabelText("Parent future")).toHaveValue(IDS.POPULAR);
    type("second change");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(posts(a)).toHaveLength(2));
    expect(posts(a)[1].body).toMatchObject({ parent_id: IDS.POPULAR });
    expect(nonGenerationMutations(a)).toEqual([]);
    expect(screen.getByText("Live · Popular feed")).toBeInTheDocument();
  });

  it("keeps an explicitly chosen parent across inspection and refresh, scoped to its engine", async () => {
    const first = await boot();
    fireEvent.change(screen.getByLabelText("Parent future"), { target: { value: IDS.ROOT } });
    const parent = screen.getByLabelText("Parent future");
    expect(parent).toHaveValue(IDS.ROOT);
    expect(document.getElementById(parent.getAttribute("aria-describedby")!)).toHaveTextContent("chosen");
    await selectInFutures("UI popular");
    expect(parent).toHaveValue(IDS.ROOT);
    first.unmount();

    const second = await boot();
    expect(screen.getByLabelText("Parent future")).toHaveValue(IDS.ROOT);
    type("from original");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await waitFor(() => expect(posts(a)).toHaveLength(1));
    expect(posts(a)[0].body).toMatchObject({ parent_id: IDS.ROOT });
    await switchEngine(B);
    await screen.findByText("Live · Bee Popular feed");
    expect(screen.getByLabelText("Parent future")).toHaveValue(IDS.POPULAR);
    second.unmount();

    localStorage.setItem("paradox.apiBase", A);
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Use live" }));
    expect(screen.getByLabelText("Parent future")).toHaveValue(IDS.POPULAR);
    expect(screen.queryByRole("button", { name: "Use live" })).not.toBeInTheDocument();
    expect(nonGenerationMutations(a)).toEqual([]);
    expect(b.mutations()).toEqual([]);
  });

  it("refuses a chosen parent that was declined or no longer exists instead of switching silently", async () => {
    const first = await boot();
    fireEvent.change(screen.getByLabelText("Parent future"), { target: { value: IDS.AI } });
    first.unmount();
    a.timelines = a.timelines.map((item) => (item.id === IDS.AI ? { ...item, status: "declined" } : item));
    const second = await boot();
    expect(screen.getByLabelText("Parent future")).toHaveValue("");
    type("popular");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    expect(await screen.findByText("The chosen parent future was declined. Choose another parent.")).toBeInTheDocument();
    second.unmount();

    a.timelines = a.timelines.filter((item) => item.id !== IDS.AI);
    await boot();
    type("popular");
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    expect(await screen.findByText("The chosen parent future no longer exists on this engine. Choose a parent.")).toBeInTheDocument();
    expect(a.mutations()).toEqual([]);
  });
});
