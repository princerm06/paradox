import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine, IDS, generation, multiEngineFetch, type Call } from "./fakeEngine.ts";

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

const strip = () => document.querySelector(".submission") as HTMLElement | null;
const findStrip = (text: string) => waitFor(() => expect(strip()).toHaveTextContent(text));
const UNCONFIRMED = /did not confirm this was the tab's own request/;
const posts = (engine: FakeEngine) => engine.mutations().filter((call) => call.method === "POST" && call.path === "/api/generations");

/** The engine creates the record, then holds the HTTP response until the test releases it (or never). */
function delayPostResponse(engine: FakeEngine) {
  const held: Array<() => void> = [];
  engine.overrides.push((call: Call) => {
    if (call.method !== "POST" || call.path !== "/api/generations") return undefined;
    const response = engine.route(call, new URL(`${A}${call.path}`));
    return new Promise<Response>((resolve) => held.push(() => resolve(response)));
  });
  return { release: () => held.splice(0).forEach((done) => done()) };
}

type Outcome = "ok" | "5xx" | "malformed" | "empty" | "unreadable" | "network" | "422";

/** The engine creates each record at request time; each response is released individually with a chosen outcome. */
function holdPosts(engine: FakeEngine) {
  const held: Array<(outcome: Outcome) => void> = [];
  engine.overrides.push((call: Call) => {
    if (call.method !== "POST" || call.path !== "/api/generations") return undefined;
    const response = engine.route(call, new URL(`${A}${call.path}`));
    return new Promise<Response>((resolve, reject) =>
      held.push((outcome) => {
        if (outcome === "ok") resolve(response);
        else if (outcome === "5xx") resolve(new Response(JSON.stringify({ detail: "worker crashed" }), { status: 502 }));
        else if (outcome === "malformed") resolve(new Response("{not json", { status: 201 }));
        else if (outcome === "empty") resolve(new Response("", { status: 201 }));
        else if (outcome === "unreadable") resolve(new Response(new ReadableStream({ start: (controller) => controller.error(new Error("reset")) }), { status: 201 }));
        else if (outcome === "422") resolve(new Response(JSON.stringify({ detail: "prompt rejected" }), { status: 422 }));
        else reject(new TypeError("Failed to fetch"));
      }),
    );
  });
  return { release: (index: number, outcome: Outcome = "ok") => held[index](outcome), count: () => held.length };
}

async function boot() {
  const view = render(<App />);
  await screen.findByText("Live · Popular feed");
  await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
  return view;
}

async function submit(prompt: string) {
  fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Starting/ })).toBeInTheDocument());
}

function newest(engine: FakeEngine) {
  return engine.generations[engine.generations.length - 1];
}

function makeRunning(record: ReturnType<typeof newest>, status = "generating") {
  record.status = status;
  record.updated_at = new Date(Date.now() + 1).toISOString();
}

describe("refresh before the generation POST response", () => {
  it("recovers the new generation instead of the previous completed submission", async () => {
    const first = await boot();
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "first change" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    await screen.findByText("first change", { selector: ".submission-head strong" });
    const previous = newest(a);
    previous.status = "succeeded";
    previous.updated_at = new Date(Date.now() + 1000).toISOString();
    await screen.findByText(/Validated/, undefined, { timeout: 3000 });

    delayPostResponse(a);
    await submit("slow second change");
    const created = newest(a);
    expect(created.prompt).toBe("slow second change");
    makeRunning(created);
    first.unmount();

    render(<App />);
    await findStrip("slow second change");
    expect(strip()).not.toHaveTextContent("first change");
    expect(strip()).toHaveTextContent(/Recovered without the engine.s response/);
    expect(strip()).toHaveTextContent(UNCONFIRMED);
    expect(within(strip()!).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(posts(a)).toHaveLength(2);
  });

  it("recovers on a fresh tab session with no prior submission", async () => {
    const first = await boot();
    delayPostResponse(a);
    await submit("slow fresh change");
    makeRunning(newest(a));
    first.unmount();

    render(<App />);
    await findStrip("slow fresh change");
    expect(strip()).toHaveTextContent(/Recovered without the engine.s response/);
    expect(posts(a)).toHaveLength(1);
  });

  it("shows a run that completed while the page was reloading with its real outcome", async () => {
    const first = await boot();
    delayPostResponse(a);
    await submit("quick change");
    const created = newest(a);
    first.unmount();
    created.status = "failed";
    created.error = { stage: "tests", message: "1 failed" };
    created.updated_at = new Date(Date.now() + 1000).toISOString();

    render(<App />);
    await findStrip("quick change");
    expect(strip()).toHaveTextContent("Failed · tests");
    expect(strip()).toHaveTextContent("1 failed");
    expect(within(strip()!).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(posts(a)).toHaveLength(1);
  });

  it("follows a cancel made after the reload from the engine's record", async () => {
    const first = await boot();
    delayPostResponse(a);
    await submit("slow cancel me");
    makeRunning(newest(a));
    first.unmount();

    render(<App />);
    await findStrip("slow cancel me");
    fireEvent.click(within(strip()!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(strip()).toHaveTextContent("Cancelled"));
    expect(a.mutations().filter((call) => call.path.endsWith("/cancel"))).toEqual([expect.objectContaining({ path: `/api/generations/${newest(a).id}/cancel` })]);
    expect(posts(a)).toHaveLength(1);
  });

  it("does not guess when several matching runs exist and lets the user pick one", async () => {
    const first = await boot();
    delayPostResponse(a);
    await submit("slow twin");
    const mine = newest(a);
    makeRunning(mine);
    first.unmount();
    // Another client submitted an identical request in the meantime.
    const twin = generation({ ...mine, id: "dddddddd-0000-0000-0000-00000000000d", created_at: new Date(Date.now() + 5).toISOString(), status: "queued" });
    a.generations.push(twin);
    // And an unrelated run from another client.
    a.generations.push(generation({ id: "eeeeeeee-0000-0000-0000-0000000000ee", name: "Unrelated", prompt: "other", status: "generating", timeline_id: null, finished_at: null, created_at: new Date(Date.now() + 10).toISOString() }));

    render(<App />);
    const panel = await screen.findByRole("group", { name: "Unconfirmed submission" });
    await waitFor(() => expect(panel).toHaveTextContent(/2 engine records match/));
    expect(panel).not.toHaveTextContent("Unrelated");
    expect(strip()).toBeNull();
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Track this one" }));
    await findStrip("slow twin");
    expect(strip()).toHaveTextContent(UNCONFIRMED);
    expect(screen.queryByRole("group", { name: "Unconfirmed submission" })).not.toBeInTheDocument();
    expect(posts(a)).toHaveLength(1);
    expect(a.mutations()).toHaveLength(1);
  });

  it("is honest when no matching record exists and never resubmits", async () => {
    a.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? new Promise<Response>(() => {}) : undefined));
    const first = await boot();
    await submit("never arrived");
    first.unmount();

    render(<App />);
    const panel = await screen.findByRole("group", { name: "Unconfirmed submission" });
    await waitFor(() => expect(panel).toHaveTextContent(/No matching generation was found/));
    expect(panel).not.toHaveTextContent(/Checking/);
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("group", { name: "Unconfirmed submission" })).not.toBeInTheDocument();
    expect(posts(a)).toHaveLength(1);
  });

  it("does not adopt an older record with the same prompt", async () => {
    a.generations.push(generation({ id: "abababab-0000-0000-0000-0000000000ab", name: "same prompt", prompt: "same prompt", status: "succeeded", timeline_id: IDS.AI }));
    a.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? new Promise<Response>(() => {}) : undefined));
    const first = await boot();
    await submit("same prompt");
    first.unmount();

    render(<App />);
    const panel = await screen.findByRole("group", { name: "Unconfirmed submission" });
    await waitFor(() => expect(panel).toHaveTextContent(/No matching generation was found/));
    expect(strip()).toBeNull();
  });

  it("keeps the interrupted submission on its own engine across a switch", async () => {
    const first = await boot();
    delayPostResponse(a);
    await submit("slow engine bound");
    makeRunning(newest(a));
    first.unmount();

    localStorage.setItem("paradox.apiBase", B);
    const second = render(<App />);
    await screen.findByText("Live · Bee Popular feed");
    expect(screen.queryByRole("group", { name: "Unconfirmed submission" })).not.toBeInTheDocument();
    expect(screen.queryByText("slow engine bound")).not.toBeInTheDocument();
    second.unmount();

    localStorage.setItem("paradox.apiBase", A);
    render(<App />);
    await findStrip("slow engine bound");
    expect(posts(a)).toHaveLength(1);
    expect(b.mutations()).toEqual([]);
  });

  it("matches the delayed response once it arrives, before or after the list", async () => {
    const delay = delayPostResponse(a);
    await boot();
    await submit("slow same page");
    makeRunning(newest(a));
    delay.release();
    await findStrip("slow same page");
    expect(strip()).not.toHaveTextContent(/Recovered without the engine.s response/);
    expect(strip()).not.toHaveTextContent(UNCONFIRMED);
    expect(screen.queryByRole("group", { name: "Unconfirmed submission" })).not.toBeInTheDocument();
    expect(posts(a)).toHaveLength(1);
  });

  it("labels a lone match as unconfirmed when another client sent the identical request and ours never arrived", async () => {
    a.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? new Promise<Response>(() => {}) : undefined));
    const first = await boot();
    await submit("slow lookalike");
    const body = posts(a)[0].body as { parent_id: string; prompt: string; provider: string; activate_on_success: boolean };
    first.unmount();
    a.generations.push(generation({ id: "dededede-0000-0000-0000-0000000000de", name: "slow lookalike", prompt: body.prompt, parent_id: body.parent_id, provider: body.provider, activate_on_success: body.activate_on_success, status: "generating", timeline_id: null, finished_at: null, created_at: new Date().toISOString() }));

    render(<App />);
    await findStrip("slow lookalike");
    expect(strip()).toHaveTextContent(UNCONFIRMED);
    expect(strip()).not.toHaveTextContent(/Restored after reload from the engine's record/);
    expect(posts(a)).toHaveLength(1);
  });

  it("picks up a record that only appears in a later list, without resubmitting or removing history", async () => {
    a.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? new Promise<Response>(() => {}) : undefined));
    const first = await boot();
    await submit("slow late record");
    const body = posts(a)[0].body as { parent_id: string; prompt: string; provider: string; activate_on_success: boolean };
    first.unmount();

    render(<App />);
    const panel = await screen.findByRole("group", { name: "Unconfirmed submission" });
    await waitFor(() => expect(panel).toHaveTextContent(/No matching generation was found/));
    a.generations.push(generation({ id: "fafafafa-0000-0000-0000-0000000000fa", name: "slow late record", prompt: body.prompt, parent_id: body.parent_id, provider: body.provider, activate_on_success: body.activate_on_success, status: "queued", timeline_id: null, finished_at: null, created_at: new Date().toISOString() }));
    fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
    await findStrip("slow late record");
    expect(strip()).toHaveTextContent(UNCONFIRMED);
    expect(posts(a)).toHaveLength(1);
    expect(a.generations.map((item) => item.id)).toContain(IDS.GEN_AI);
  });
});

describe("stale and ambiguous POST outcomes", () => {
  const sessionKey = `paradox.session:${A}:pendingSubmit`;

  it.each(["ok", "5xx"] as const)("a late %s response for A never replaces B submitted after switching away and back", async (outcome) => {
    const hold = holdPosts(a);
    const first = await boot();
    await submit("slow first A");
    const recordA = newest(a);
    makeRunning(recordA);
    first.unmount();

    localStorage.setItem("paradox.apiBase", B);
    const away = render(<App />);
    await screen.findByText("Live · Bee Popular feed");
    away.unmount();

    localStorage.setItem("paradox.apiBase", A);
    const back = await boot();
    await submit("slow second B");
    const recordB = newest(a);
    makeRunning(recordB);
    expect(JSON.parse(sessionStorage.getItem(sessionKey)!).prompt).toBe("slow second B");

    await act(async () => hold.release(0, outcome));
    await waitFor(() => expect(hold.count()).toBe(2));
    expect(JSON.parse(sessionStorage.getItem(sessionKey)!).prompt).toBe("slow second B");
    expect(sessionStorage.getItem(`paradox.session:${A}:submission`)).toBeNull();
    back.unmount();

    render(<App />);
    await findStrip("slow second B");
    expect(strip()).not.toHaveTextContent("slow first A");
    expect(strip()).toHaveTextContent(UNCONFIRMED);
    expect(a.generations.map((item) => item.id)).toEqual(expect.arrayContaining([recordA.id, recordB.id]));
    expect(posts(a)).toHaveLength(2);
    expect(b.mutations()).toEqual([]);
  });

  it("a late response that arrives while another engine is shown still resolves its own request", async () => {
    const hold = holdPosts(a);
    const first = await boot();
    await submit("slow away resolve");
    const created = newest(a);
    makeRunning(created);
    first.unmount();

    localStorage.setItem("paradox.apiBase", B);
    const away = render(<App />);
    await screen.findByText("Live · Bee Popular feed");
    await act(async () => hold.release(0));
    await waitFor(() => expect(sessionStorage.getItem(`paradox.session:${A}:submission`)).toBe(created.id));
    expect(sessionStorage.getItem(sessionKey)).toBeNull();
    away.unmount();

    localStorage.setItem("paradox.apiBase", A);
    render(<App />);
    await findStrip("slow away resolve");
    expect(strip()).not.toHaveTextContent(UNCONFIRMED);
    expect(posts(a)).toHaveLength(1);
  });

  it.each(["5xx", "malformed", "empty", "unreadable", "network"] as const)(
    "keeps the request context when the engine accepted it but the response was %s",
    async (outcome) => {
      const hold = holdPosts(a);
      a.generations.push(generation({ id: "c0c0c0c0-0000-0000-0000-0000000000c0", name: "Other client run", prompt: "other", status: "generating", timeline_id: null, finished_at: null, created_at: new Date(Date.now() + 10).toISOString() }));
      await boot();
      await submit("ambiguous change");
      const created = newest(a);
      makeRunning(created);
      await act(async () => hold.release(0, outcome));

      await screen.findByText(/The outcome is unknown/);
      await findStrip("ambiguous change");
      expect(strip()).toHaveTextContent(UNCONFIRMED);
      expect(strip()).not.toHaveTextContent("Other client run");
      expect(JSON.parse(sessionStorage.getItem(sessionKey)!).failure).toBeTruthy();
      fireEvent.click(within(strip()!).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(strip()).toHaveTextContent("Cancelled"));
      expect(a.mutations().filter((call) => call.path.endsWith("/cancel"))).toEqual([expect.objectContaining({ path: `/api/generations/${created.id}/cancel` })]);
      expect(posts(a)).toHaveLength(1);
    },
  );

  it("shows outcome unknown, not another client's run, when nothing matching was created", async () => {
    a.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? new Response(JSON.stringify({ detail: "upstream timeout" }), { status: 504 }) : undefined));
    a.generations.push(generation({ id: "c1c1c1c1-0000-0000-0000-0000000000c1", name: "Other client run", prompt: "other", status: "generating", timeline_id: null, finished_at: null, created_at: new Date(Date.now() + 10).toISOString() }));
    await boot();
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "maybe lost" } });
    fireEvent.click(screen.getByRole("button", { name: /Generate future/ }));
    const panel = await screen.findByRole("group", { name: "Unconfirmed submission" });
    expect(panel).toHaveTextContent("Outcome unknown");
    await waitFor(() => expect(panel).toHaveTextContent(/No matching generation was found/));
    expect(strip()).toBeNull();
    expect(posts(a)).toHaveLength(1);
  });

  it("clears the request context on a definitive 4xx rejection", async () => {
    const hold = holdPosts(a);
    await boot();
    await submit("rejected change");
    await act(async () => hold.release(0, "422"));
    await screen.findByText(/prompt rejected/);
    expect(screen.queryByText(/The outcome is unknown/)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Unconfirmed submission" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(sessionKey)).toBeNull();
    expect(posts(a)).toHaveLength(1);
  });

  it("turns a lone guess back into a list when an identical record appears in a later poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      a.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? new Promise<Response>(() => {}) : undefined));
      const first = await boot();
      await submit("slow successive");
      const body = posts(a)[0].body as { parent_id: string; prompt: string; provider: string; activate_on_success: boolean };
      first.unmount();
      const lookalike = { name: "slow successive", prompt: body.prompt, parent_id: body.parent_id, provider: body.provider, activate_on_success: body.activate_on_success, status: "generating", timeline_id: null, finished_at: null };
      a.generations.push(generation({ ...lookalike, id: "a1a1a1a1-0000-0000-0000-0000000000a1", created_at: new Date().toISOString() }));

      render(<App />);
      await findStrip("slow successive");
      expect(strip()).toHaveTextContent(UNCONFIRMED);
      expect(sessionStorage.getItem(sessionKey)).not.toBeNull();

      a.generations.push(generation({ ...lookalike, id: "a2a2a2a2-0000-0000-0000-0000000000a2", created_at: new Date(Date.now() + 5).toISOString() }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_500);
      });
      const panel = await screen.findByRole("group", { name: "Unconfirmed submission" });
      await waitFor(() => expect(panel).toHaveTextContent(/2 engine records match/));
      expect(strip()).toBeNull();
      expect(document.querySelectorAll(".submission-unconfirmed")).toHaveLength(1);

      const later = within(panel).getAllByRole("listitem").find((row) => row.textContent?.includes("a2a2a2a2"))!;
      fireEvent.click(within(later).getByRole("button", { name: "Track this one" }));
      await findStrip("slow successive");
      expect(sessionStorage.getItem(sessionKey)).toBeNull();
      expect(sessionStorage.getItem(`paradox.session:${A}:submission`)).toBe("a2a2a2a2-0000-0000-0000-0000000000a2");
      expect(strip()).toHaveTextContent(UNCONFIRMED);
      expect(posts(a)).toHaveLength(1);
      expect(a.mutations()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
