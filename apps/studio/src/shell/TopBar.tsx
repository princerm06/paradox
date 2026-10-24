import { timelineById } from "../graph/tree.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { Mark } from "./icons.tsx";
import type { StudioMode } from "./navigation.tsx";
import { SettingsMenu } from "./SettingsMenu.tsx";

export type { StudioMode };

const MODES: { id: StudioMode; label: string }[] = [
  { id: "explore", label: "Explore" },
  { id: "architect", label: "Architect" },
  { id: "analyze", label: "Analyze" },
];

export function TopBar({
  mode,
  onMode,
  futuresOpen,
  onFutures,
  inspectorOpen,
  onInspector,
  portalOpen,
  onPortal,
}: {
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  futuresOpen: boolean;
  onFutures: () => void;
  inspectorOpen: boolean;
  onInspector: () => void;
  portalOpen: boolean;
  onPortal: () => void;
}) {
  const { timelines, activeTimelineId, connected, health } = useWorkspace();
  const active = timelineById(timelines, activeTimelineId);
  const engineOn = connected && health?.status === "ok" && health.runtime_running;
  const engineLabel = !connected ? "Engine offline" : !health ? "Engine connecting" : health.runtime_running ? "Engine connected, runtime running" : "Engine connected, runtime stopped";

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Mark />
        <div>
          <strong>Paradox</strong>
          <span>Software time machine</span>
        </div>
      </div>
      <nav className="mode-nav" aria-label="Studio modes">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? "mode-tab is-on" : "mode-tab"}
            aria-current={mode === item.id ? "page" : undefined}
            onClick={() => onMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="topbar-tools">
        {mode === "explore" ? (
          <>
            <button type="button" className={futuresOpen ? "text-btn is-on" : "text-btn"} aria-pressed={futuresOpen} onClick={onFutures}>
              Futures
            </button>
            <button type="button" className={inspectorOpen ? "text-btn is-on" : "text-btn"} aria-pressed={inspectorOpen} onClick={onInspector}>
              Inspect
            </button>
            <button type="button" className={portalOpen ? "text-btn is-on" : "text-btn"} aria-pressed={portalOpen} onClick={onPortal}>
              Portal
            </button>
          </>
        ) : null}
        <p className="live-chip" title="Backend-confirmed running application">
          <span className={active && connected ? "dot ok" : "dot warn"} aria-hidden="true" />
          <span>{active ? `Live · ${active.name}` : connected ? "No live future" : "Live state unknown"}</span>
        </p>
        <span className={engineOn ? "dot ok" : connected ? "dot warn" : "dot bad"} title={engineLabel} role="img" aria-label={engineLabel} />
        <SettingsMenu />
      </div>
    </header>
  );
}
