import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine, deferred, generation } from "./fakeEngine.ts";

let engine: FakeEngine;

beforeEach(() => {
  vi.useFakeTimers();
  engine = new FakeEngine();
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.useRealTimers();
});

async function advance(ms: number, step = 1000) {
  for (let spent = 0; spent < ms; spent += step) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

const strip = () => document.querySelector(".submission") as HTMLElement | null;

describe("long-running generations", () => {
  it("keeps polling a generation that runs longer than six minutes, without timing out", async () => {
    const id = "12121212-0000-0000-0000-000000000012";
    const running = generation({ id, name: "Long run", status: "generating", timeline_id: null, finished_at: null, evaluation: null, changes: null });
    engine.generations.push(running);
    render(<App />);
    await advance(1500, 100);
    expect(strip()).toHaveTextContent("Long run");
    expect(strip()).toHaveTextContent("Generating");

    await advance(6.5 * 60_000, 5000);
    const polls = engine.calls.filter((call) => call.path === `/api/generations/${id}`).length;
    // About once a second for 6.5 minutes (the poll skips while a previous one is in flight).
    expect(polls).toBeGreaterThan(300);
    expect(strip()).toHaveTextContent("Generating");
    expect(screen.queryByText(/timed out|could not/i)).not.toBeInTheDocument();
    expect(strip()?.querySelector("button")?.textContent).toBeTruthy();

    running.status = "validating";
    running.updated_at = new Date(Date.now() + 400_000).toISOString();
    await advance(1500, 500);
    expect(strip()).toHaveTextContent("Validating");

    engine.timelines.push({ ...engine.timelines[2], id: "34343434-0000-0000-0000-000000000034", name: "Long run", generation_id: id });
    running.status = "succeeded";
    running.timeline_id = "34343434-0000-0000-0000-000000000034";
    running.updated_at = new Date(Date.now() + 401_000).toISOString();
    await advance(2500, 500);
    expect(strip()).toHaveTextContent("The new future is pending");
    expect(engine.mutations()).toEqual([]);
  });

  it("shows the failing stage and message and keeps the evidence reachable", async () => {
    const id = "13131313-0000-0000-0000-000000000013";
    const running = generation({ id, name: "Will fail", status: "validating", timeline_id: null, finished_at: null });
    engine.generations.push(running);
    render(<App />);
    await advance(1500, 100);
    running.status = "failed";
    running.error = { stage: "tests", message: "1 failed, 0 errors; inspect validation logs" };
    running.updated_at = new Date(Date.now() + 10_000).toISOString();
    await advance(2000, 500);
    expect(strip()).toHaveTextContent("Failed · tests");
    expect(strip()).toHaveTextContent("1 failed, 0 errors; inspect validation logs");
    // A failure is never presented as success.
    expect(strip()).not.toHaveTextContent(/Validated|pending/);
    fireEvent.click(strip()!.querySelector("button") as HTMLElement);
    await advance(500, 100);
    expect(screen.getByRole("complementary", { name: "Future inspector" })).toHaveTextContent("Will fail");
  });

  it("creates one generation even when Generate is pressed twice in a frame", async () => {
    const hold = deferred<Response>();
    engine.overrides.push((call) => (call.method === "POST" && call.path === "/api/generations" ? hold.promise : undefined));
    render(<App />);
    await advance(1500, 100);
    fireEvent.change(screen.getByLabelText("What would you like to change?"), { target: { value: "popular" } });
    const button = screen.getByRole("button", { name: /Generate future/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByLabelText("What would you like to change?"), { key: "Enter", metaKey: true });
    await advance(200, 100);
    expect(engine.mutations().filter((call) => call.path === "/api/generations")).toHaveLength(1);
  });
});

describe("vanished generations", () => {
  it("stops showing a run as in flight once the engine reports it missing", async () => {
    const id = "15151515-0000-0000-0000-000000000015";
    engine.generations.push(generation({ id, name: "Ghost run", status: "generating", timeline_id: null, finished_at: null }));
    render(<App />);
    await advance(1500, 100);
    expect(screen.getByText(/1 generating/)).toBeInTheDocument();
    engine.generations = engine.generations.filter((item) => item.id !== id);
    await advance(2000, 500);
    expect(screen.queryByText(/1 generating/)).not.toBeInTheDocument();
    const polls = engine.calls.filter((call) => call.path === `/api/generations/${id}`).length;
    await advance(5000, 1000);
    expect(engine.calls.filter((call) => call.path === `/api/generations/${id}`).length).toBe(polls);
  });
});
