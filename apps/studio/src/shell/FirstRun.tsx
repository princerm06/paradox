import { useEngine } from "../state/engine.tsx";
import { useWorkspace } from "../state/workspace.tsx";

/** Shown only when the engine has never answered, or answered with no timelines. */
export function FirstRun() {
  const { loaded, loading, listError, timelines, reload } = useWorkspace();
  const { base } = useEngine();
  if (loaded && timelines.length > 0) return null;
  if (!loaded && (loading || !listError)) return null;
  const offline = !loaded;
  return (
    <section className="first-run glass-panel" aria-labelledby="first-run-title">
      <p className="brand-kicker">{offline ? "Engine offline" : "No timelines"}</p>
      <h2 id="first-run-title">{offline ? "Paradox can't reach its timeline engine" : "The engine has no timelines yet"}</h2>
      {offline ? (
        <>
          <p>
            The studio is looking for the engine at <code>{base}</code>. {listError}
          </p>
          <ol>
            <li>
              Start it from the repository root: <code>.venv/bin/python -m engine --port 8000</code>
            </li>
            <li>Or point the studio at another engine URL in Settings.</li>
          </ol>
        </>
      ) : (
        <p>The engine creates the root timeline when it starts. Restart it, or check that it is using the expected state directory.</p>
      )}
      <button type="button" className="btn primary" onClick={reload}>
        Retry
      </button>
    </section>
  );
}
