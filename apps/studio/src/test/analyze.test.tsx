import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine, IDS } from "./fakeEngine.ts";

let engine: FakeEngine;

beforeEach(() => {
  engine = new FakeEngine();
  vi.stubGlobal("fetch", engine.fetch);
});

async function openAnalyze() {
  render(<App />);
  await screen.findByText(/Live · Popular feed/);
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
  return { a: await screen.findByLabelText("Future A"), b: screen.getByLabelText("Future B") };
}

it("shows only recorded evidence and labels what nobody measured", async () => {
  const { a, b } = await openAnalyze();
  fireEvent.change(a, { target: { value: `timeline:${IDS.ROOT}` } });
  fireEvent.change(b, { target: { value: `timeline:${IDS.AI}` } });
  const coverage = within(await screen.findByRole("complementary", { name: "Evidence coverage" }));
  expect(coverage.getByText("No validation record")).toBeInTheDocument();
  expect(await coverage.findByText("Checks passed")).toBeInTheDocument();
  for (const item of ["Runtime performance", "Vulnerability scan", "Direct A↔B patch"]) expect(coverage.getByText(item)).toBeInTheDocument();
  expect(coverage.getAllByText("Unavailable")).toHaveLength(3);
  expect(screen.getByLabelText("Evidence key")).toHaveTextContent("No estimates or simulated metrics");
  expect(engine.mutations()).toEqual([]);
});

it("swaps baseline and comparison without touching the runtime", async () => {
  const { a, b } = await openAnalyze();
  fireEvent.change(a, { target: { value: `timeline:${IDS.ROOT}` } });
  fireEvent.change(b, { target: { value: `timeline:${IDS.AI}` } });
  const head = within(screen.getByRole("region", { name: "Futures being compared" }));
  fireEvent.click(head.getByRole("button", { name: "Swap A and B" }));
  expect(screen.getByLabelText("Future A")).toHaveValue(`timeline:${IDS.AI}`);
  expect(screen.getByLabelText("Future B")).toHaveValue(`timeline:${IDS.ROOT}`);
  expect(head.getByText("Choosing futures here never activates them.")).toBeInTheDocument();
  for (const tab of ["Validation", "Files", "Diffs", "Logs", "Summary"]) fireEvent.click(screen.getByRole("tab", { name: tab }));
  expect(engine.mutations()).toEqual([]);
  expect(screen.getByText(/Live · Popular feed/)).toBeInTheDocument();
});
