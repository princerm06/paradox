import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FutureVisual, SelectionChip } from "./FutureVisual.tsx";

it("labels decorative card art as unavailable capture, never an application screenshot", () => {
  const { container } = render(<FutureVisual />);
  expect(screen.getByRole("img", { name: "Application capture unavailable" })).toBeInTheDocument();
  expect(screen.getByText("No capture")).toBeInTheDocument();
  expect(container.querySelector("img, iframe")).toBeNull();
});

it("keeps attempt artwork and selection independent of runtime status", () => {
  render(<><FutureVisual attempt /><SelectionChip /></>);
  expect(screen.getByRole("img", { name: /Generation attempt/ })).toBeInTheDocument();
  expect(screen.getByText("Selected")).toBeInTheDocument();
  expect(screen.queryByText("Live")).not.toBeInTheDocument();
});
