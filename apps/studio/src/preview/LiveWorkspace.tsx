import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../state/workspace.tsx";
import { timelineById } from "../graph/tree.ts";
import { RefreshIcon } from "../shell/icons.tsx";

export function LiveWorkspace({
  expanded,
  onExpandedChange,
  onCollapse,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onCollapse: () => void;
}) {
  const { appUrl, timelines, activeTimelineId, selectedId, connected, healthError, previewNonce, refreshPreview } = useWorkspace();
  const active = timelineById(timelines, activeTimelineId);
  const inspectingAnother = Boolean(selectedId && activeTimelineId && selectedId !== activeTimelineId);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [arriving, setArriving] = useState(false);
  const seenNonce = useRef(previewNonce);

  useEffect(() => {
    if (seenNonce.current === previewNonce) return;
    seenNonce.current = previewNonce;
    setArriving(true);
    const timer = window.setTimeout(() => setArriving(false), 520);
    return () => window.clearTimeout(timer);
  }, [previewNonce]);

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
    <section className={expanded ? "portal-float is-expanded" : "portal-float"} aria-label="Live application">
      <div className={arriving ? "portal is-arriving" : "portal"}>
      <header className="browser">
        <div className="traffic" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="live-identity">
          <span className={active ? "dot ok" : "dot warn"} />
          <strong>{active ? active.name : "No live future"}</strong>
        </div>
        <div className="url" title={appUrl || "Waiting for the engine"}>
          {appUrl || "Waiting for app URL"}
        </div>
        <button type="button" className="icon-btn" onClick={refreshPreview} aria-label="Refresh preview" disabled={!appUrl}>
          <RefreshIcon />
        </button>
        <button type="button" className="text-btn" onClick={() => onExpandedChange(!expanded)}>
          {expanded ? "Shrink" : "Expand"}
        </button>
        <button type="button" className="text-btn" onClick={onCollapse}>
          Hide
        </button>
      </header>
      {inspectingAnother || (!connected && healthError) ? (
        <div className="live-strip">
          {inspectingAnother ? <span className="strip-note">Inspection does not switch the runtime.</span> : null}
          {!connected && healthError ? <span className="strip-error">{healthError}</span> : null}
        </div>
      ) : null}
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
                {arriving ? "Opening this future" : "Opening the live application"}
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
      </div>
    </section>
  );
}
