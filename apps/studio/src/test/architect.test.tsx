import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine, IDS } from "./fakeEngine.ts";

let engine: FakeEngine;

beforeEach(() => {
  engine = new FakeEngine();
  vi.stubGlobal("fetch", engine.fetch);
});

it("inspects source-labelled system relationships without activating or generating", async () => {
  render(<App />);
  await screen.findByText("Live · Popular feed");
  fireEvent.click(screen.getByRole("button", { name: "Architect" }));
  await screen.findByRole("heading", { name: "System Architecture" });
  expect(screen.getByText("System context, not an imported-project topology.")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: /^Timeline engine,.*observed/ }));
  const inspector = within(screen.getByRole("complementary", { name: "Architecture inspector" }));
  expect(inspector.getByRole("heading", { name: "Timeline engine" })).toBeInTheDocument();
  expect(inspector.getAllByText("GET /api/health").length).toBeGreaterThan(0);
  expect(inspector.getByRole("heading", { name: "System relationships" })).toBeInTheDocument();
  fireEvent.click(inspector.getByRole("button", { name: "→ Timeline store" }));
  expect(inspector.getByRole("heading", { name: "Timeline store" })).toBeInTheDocument();
  expect(inspector.getAllByText("Documented").length).toBeGreaterThan(0);
  expect(inspector.getByText("Unavailable")).toBeInTheDocument();
  expect(inspector.getByText("Imported-project topology and architecture comparison")).toBeInTheDocument();
  expect(screen.getByText("Inferred from file paths")).toBeInTheDocument();
  expect(screen.queryByText("Redis Cache")).not.toBeInTheDocument();
  expect(screen.queryByText("Postgres")).not.toBeInTheDocument();
  expect(engine.activeId).toBe(IDS.POPULAR);
  expect(engine.mutations()).toEqual([]);
});

it("retains live endpoint evidence and real generation file overlays", async () => {
  render(<App />);
  await screen.findByText("Live · Popular feed");
  fireEvent.click(screen.getByRole("button", { name: "Architect" }));
  fireEvent.click(await screen.findByRole("tab", { name: /^Endpoints/ }));
  await screen.findByText("GET /openapi.json");
  expect(screen.getByText(/operations\. The app proxy/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Future to overlay"), { target: { value: `timeline:${IDS.AI}` } });
  fireEvent.click(screen.getByRole("tab", { name: /^Changes/ }));
  const map = within(screen.getByRole("region", { name: "Architecture map" }));
  const file = await map.findByRole("button", { name: /ranking.py/ });
  fireEvent.click(file);
  const inspector = within(screen.getByRole("complementary", { name: "Architecture inspector" }));
  expect(inspector.getByRole("heading", { name: "demo_app/ranking.py" })).toBeInTheDocument();
  expect(inspector.getByText("scripted agent")).toBeInTheDocument();
  expect(engine.mutations()).toEqual([]);
});
