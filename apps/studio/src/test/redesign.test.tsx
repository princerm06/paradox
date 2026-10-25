import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { FakeEngine } from "./fakeEngine.ts";

let engine: FakeEngine;

beforeEach(() => {
  engine = new FakeEngine();
  vi.stubGlobal("fetch", engine.fetch);
});

it("uses the exported brand and keeps rail navigation read-only", async () => {
  render(<App />);
  await screen.findByText(/Live · Popular feed/);
  expect(document.querySelector(".topbar-brand img")).toHaveAttribute("src", "/paradox-mark.svg");
  expect(screen.getByRole("heading", { name: "Software Futures" })).toBeInTheDocument();
  const rail = within(screen.getByRole("navigation", { name: "Explore tools" }));
  fireEvent.click(rail.getByRole("button", { name: "Futures" }));
  expect(screen.getByRole("complementary", { name: "Futures" })).toBeInTheDocument();
  fireEvent.click(rail.getByRole("button", { name: "Timeline" }));
  expect(screen.queryByRole("complementary", { name: "Futures" })).not.toBeInTheDocument();
  fireEvent.click(rail.getByRole("button", { name: "Inspect" }));
  expect(screen.getByRole("complementary", { name: "Future inspector" })).toBeInTheDocument();
  fireEvent.click(rail.getByRole("button", { name: "Compare" }));
  await screen.findByLabelText("Future A");
  expect(engine.mutations()).toEqual([]);
  expect(screen.getByText(/Live · Popular feed/)).toBeInTheDocument();
});

it("focuses the real composer without submitting a generation", async () => {
  render(<App />);
  await screen.findByText(/Live · Popular feed/);
  fireEvent.click(screen.getByRole("button", { name: "Compose" }));
  expect(screen.getByLabelText("What would you like to change?")).toHaveFocus();
  await waitFor(() => expect(screen.getByLabelText("Agent provider")).toHaveValue("scripted"));
  expect(engine.mutations()).toEqual([]);
});
