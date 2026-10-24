import type { StudioMode } from "./TopBar.tsx";

export function ModePlaceholder({ mode }: { mode: Exclude<StudioMode, "explore"> }) {
  const architect = mode === "architect";
  return (
    <section className="mode-soon" aria-labelledby="mode-soon-title">
      <p className="brand-kicker">{architect ? "Architect" : "Analyze"}</p>
      <h2 id="mode-soon-title">{architect ? "Architecture workbench" : "Future comparison"}</h2>
      <p>
        {architect
          ? "Architect will inspect components, boundaries, and dependencies, then propose real architectural changes."
          : "Analyze will compare real code, validation, and any measured results between futures."}
      </p>
      <p>This mode is not built yet. Paradox is not showing a diagram, diff, or metrics here, because that evidence is not available in this view.</p>
    </section>
  );
}
