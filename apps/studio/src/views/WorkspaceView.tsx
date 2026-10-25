import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { PromptComposer } from "../composer/PromptComposer.tsx";
import { TimelineCanvas } from "../graph/TimelineCanvas.tsx";
import { TimelineExplorer } from "../graph/TimelineExplorer.tsx";
import { FutureInspector } from "../inspector/FutureInspector.tsx";
import { LiveWorkspace } from "../preview/LiveWorkspace.tsx";
import { InspectProvider } from "../shell/inspect.tsx";
import { NavigationProvider, type Navigation, type StudioMode, type Subject } from "../shell/navigation.tsx";
import { TopBar } from "../shell/TopBar.tsx";
import { useSessionState } from "../state/engine.tsx";
import { useWorkspace } from "../state/workspace.tsx";
const ArchitectView = lazy(() => import("../architect/ArchitectView.tsx").then((module) => ({ default: module.ArchitectView })));
const AnalyzeView = lazy(() => import("../analyze/AnalyzeView.tsx").then((module) => ({ default: module.AnalyzeView })));
import { FirstRun } from "../shell/FirstRun.tsx";
import { ModeIcon } from "../shell/icons.tsx";

const WIDE_STAGE = "(min-width: 1680px)";

function useWideStage(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_STAGE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_STAGE);
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

function initialMode(): StudioMode {
  const hash = window.location.hash.replace("#", "");
  return hash === "architect" || hash === "analyze" ? hash : "explore";
}

export function WorkspaceView() {
  const wide = useWideStage();
  const workspace = useWorkspace();
  const { selectTimeline, selectGeneration } = workspace;
  const [mode, setMode] = useState<StudioMode>(initialMode);
  const [futuresOpen, setFuturesOpen] = useState(() => window.matchMedia(WIDE_STAGE).matches);
  // Restored after a refresh together with the selection it was showing.
  const [inspectorFlag, setInspectorFlag] = useSessionState("inspector");
  const inspectorOpen = inspectorFlag === "1";
  const setInspectorOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(inspectorOpen) : next;
      setInspectorFlag(value ? "1" : null);
    },
    [inspectorOpen, setInspectorFlag],
  );
  const [portalOpen, setPortalOpen] = useState(true);
  const [portalExpanded, setPortalExpanded] = useState(false);
  const [pendingCompare, setPendingCompare] = useState<Subject | null>(null);
  const [pendingArchitect, setPendingArchitect] = useState<Subject | null>(null);
  const inspectorOn = inspectorOpen && mode === "explore";
  const futuresOverlay = futuresOpen && !wide;
  const stageClass = [
    "studio-stage",
    `mode-${mode}`,
    inspectorOn ? "inspector-on" : "",
    portalOpen ? "portal-on" : "",
    futuresOverlay ? "futures-overlay" : "",
    portalOpen || inspectorOn ? "has-details" : "",
    portalExpanded ? "preview-expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const layoutKey = [futuresOpen, portalOpen, portalExpanded, inspectorOn].map(Number).join("");

  const clearArchitect = useCallback(() => setPendingArchitect(null), []);
  const clearCompare = useCallback(() => setPendingCompare(null), []);

  const go = useCallback((next: StudioMode) => {
    setMode(next);
    const hash = next === "explore" ? "" : `#${next}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }, []);

  const navigation = useMemo<Navigation>(
    () => ({
      mode,
      go,
      inspectTimeline: (id) => {
        selectTimeline(id);
        setInspectorOpen(true);
        go("explore");
      },
      inspectGeneration: (id) => {
        selectGeneration(id);
        setInspectorOpen(true);
        go("explore");
      },
      compare: (subject) => {
        setPendingCompare(subject);
        go("analyze");
      },
      architect: (subject) => {
        setPendingArchitect(subject);
        go("architect");
      },
      pendingCompare,
      pendingArchitect,
    }),
    [go, mode, pendingArchitect, pendingCompare, selectGeneration, selectTimeline, setInspectorOpen],
  );

  useEffect(() => {
    if (!futuresOverlay || mode !== "explore") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFuturesOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [futuresOverlay, mode]);

  return (
    <NavigationProvider value={navigation}>
      <div className="studio">
        <a className="skip-link" href="#studio-main">
          Skip to workspace
        </a>
        <TopBar
          mode={mode}
          onMode={go}
          futuresOpen={futuresOpen}
          onFutures={() => setFuturesOpen((open) => !open)}
          inspectorOpen={inspectorOpen}
          onInspector={() => setInspectorOpen((open) => !open)}
          portalOpen={portalOpen}
          onPortal={() => {
            setPortalOpen((open) => !open);
            setPortalExpanded(false);
          }}
        />
        <main className={stageClass} id="studio-main">
          {mode === "explore" ? (
            <InspectProvider ask={() => setInspectorOpen(true)}>
              <nav className="explore-rail" aria-label="Explore tools">
                <button type="button" aria-pressed={!futuresOpen} onClick={() => setFuturesOpen(false)}>
                  <ModeIcon mode="explore" /><span>Timeline</span>
                </button>
                <button type="button" aria-pressed={futuresOpen} onClick={() => setFuturesOpen((open) => !open)}>
                  <ModeIcon mode="architect" /><span>Futures</span>
                </button>
                <button type="button" onClick={() => go("analyze")}>
                  <ModeIcon mode="analyze" /><span>Compare</span>
                </button>
                <button type="button" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}>
                  <span aria-hidden="true">⌕</span><span>Inspect</span>
                </button>
                <button type="button" className="rail-compose" onClick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>
                  <span aria-hidden="true">＋</span><span>Compose</span>
                </button>
              </nav>
              <section className="explore-canvas" aria-label="Software futures">
                <TimelineCanvas insetLeft={futuresOpen} layoutKey={layoutKey} />
                <ExploreHeader futuresOpen={futuresOpen} onFutures={() => setFuturesOpen((open) => !open)} />
                {futuresOpen ? (
                  <TimelineExplorer onClose={() => setFuturesOpen(false)} onPick={futuresOverlay ? () => setFuturesOpen(false) : undefined} />
                ) : null}
                <div className="composer-dock">
                  <PromptComposer />
                </div>
              </section>
              <div className="explore-details" hidden={!portalOpen && !inspectorOn}>
                {portalOpen ? (
                  <LiveWorkspace
                    expanded={portalExpanded}
                    onExpandedChange={setPortalExpanded}
                    onCollapse={() => {
                      setPortalOpen(false);
                      setPortalExpanded(false);
                    }}
                  />
                ) : null}
                <FutureInspector open={inspectorOpen} onToggle={() => setInspectorOpen(false)} />
              </div>
              <FirstRun />
            </InspectProvider>
          ) : null}
          <Suspense fallback={<p className="mode-loading">Loading {mode}…</p>}>
            {mode === "architect" ? <ArchitectView onConsumed={clearArchitect} /> : null}
            {mode === "analyze" ? <AnalyzeView onConsumed={clearCompare} /> : null}
          </Suspense>
        </main>
      </div>
    </NavigationProvider>
  );
}

function ExploreHeader({ futuresOpen, onFutures }: { futuresOpen: boolean; onFutures: () => void }) {
  const { timelines, generations } = useWorkspace();
  const running = generations.filter((generation) => ["queued", "preparing", "generating", "validating"].includes(generation.status)).length;
  return (
    <div className="explore-head">
      <div className="explore-head-copy">
        <p className="brand-kicker">Explore futures</p>
        <h1>Software Futures</h1>
        <span className="explore-description">Branch, experiment, and discover new versions.</span>
        <span>
          {timelines.length === 1 ? "1 timeline" : `${timelines.length} timelines`}
          {running ? <span className="inflight"> · {running} generating</span> : null}
        </span>
      </div>
      <button type="button" className={futuresOpen ? "explore-toggle is-on" : "explore-toggle"} aria-pressed={futuresOpen} onClick={onFutures}>
        Futures
      </button>
    </div>
  );
}
