import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../state/workspace.tsx";
import { timelineById } from "../graph/tree.ts";
import { PromptComposer } from "../composer/PromptComposer.tsx";
import { RefreshIcon } from "../shell/icons.tsx";

export function LiveWorkspace() {
  const { appUrl, timelines, activeTimelineId, selectedId, connected, healthError, previewNonce, refreshPreview } = useWorkspace();
  const active = timelineById(timelines, activeTimelineId);
  const inspectingAnother = Boolean(selectedId && activeTimelineId && selectedId !== activeTimelineId);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (!appUrl) {
      frame.src = "about:blank";
      return;
    }
    setPhase("loading");
    frame.src = "about:blank";
    const timer = window.setTimeout(() => {
      if (frameRef.current) frameRef.current.src = appUrl;
    }, 30);
    return () => window.clearTimeout(timer);
  }, [appUrl, previewNonce]);

  return (
    <section className="panel workspace" aria-label="Live application">
      <header className="browser">
        <div className="traffic" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="url" title={appUrl || "Waiting for the engine"}>
          {appUrl || "Waiting for app URL"}
        </div>
        <button type="button" className="icon-btn" onClick={refreshPreview} aria-label="Refresh preview" disabled={!appUrl}>
          <RefreshIcon />
        </button>
      </header>
      <div className="live-strip">
        <span className={active ? "dot ok" : "dot warn"} />
        <span>{active ? `Live · ${active.name}` : "No live timeline"}</span>
        {inspectingAnother ? <span className="strip-note">Inspection does not switch the runtime.</span> : null}
        {!connected && healthError ? <span className="strip-error">{healthError}</span> : null}
      </div>
      <div className="stage">
        {!connected && !appUrl ? (
          <div className="stage-message">
            <h2>Engine disconnected</h2>
            <p>{healthError || "The workspace cannot reach the timeline engine."}</p>
          </div>
        ) : null}
        {connected && !appUrl ? (
          <div className="stage-message">
            <h2>Preview unavailable</h2>
            <p>The timeline list did not include an application URL.</p>
          </div>
        ) : null}
        {appUrl ? (
          <>
            <iframe
              ref={frameRef}
              title="Live application"
              referrerPolicy="no-referrer"
              onLoad={(event) => {
                const src = event.currentTarget.src;
                if (!src || src.startsWith("about:")) return;
                setPhase("ready");
              }}
              onError={() => setPhase("error")}
            />
            {phase === "loading" ? (
              <div className="veil">
                <span className="spinner" />
                Opening the live application
              </div>
            ) : null}
            {phase === "error" ? (
              <div className="veil">
                <p>The live application did not load.</p>
                <button type="button" className="btn" onClick={refreshPreview}>
                  Try again
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <PromptComposer />
    </section>
  );
}
