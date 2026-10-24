import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getToken, setToken } from "../api/client.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { Mark } from "../shell/icons.tsx";
import { TimelineCanvas } from "./TimelineCanvas.tsx";

export function TimelineExplorer() {
  const { timelines, loading, listError, connected, health, healthError, reload } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);

  useEffect(() => {
    if (wasExpanded.current === expanded) return;
    wasExpanded.current = expanded;
    if (expanded) closeRef.current?.focus();
    else expandRef.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <aside className="panel explorer">
      <header className="panel-head">
        <div className="brand">
          <Mark />
          <div>
            <p className="brand-kicker">Paradox</p>
            <h1>Timeline explorer</h1>
          </div>
        </div>
        <p className="panel-note">Selection inspects a future. It does not switch the running application.</p>
      </header>
      <div className="panel-body graph-body">
        {loading && timelines.length === 0 ? <ExplorerSkeleton /> : null}
        {!loading && listError && timelines.length === 0 ? (
          <div className="empty">
            <p>{listError}</p>
            <button type="button" className="btn" onClick={reload}>
              Retry connection
            </button>
          </div>
        ) : null}
        {!loading && !listError && timelines.length === 0 ? (
          <div className="empty">
            <p>No timelines yet.</p>
          </div>
        ) : null}
        {timelines.length > 0 ? (
          <TimelineCanvas expanded={false} onExpand={() => setExpanded(true)} expandButtonRef={expandRef} />
        ) : null}
      </div>
      <footer className="panel-foot">
        <p className="foot-note">Drag to pan. Scroll to zoom. Expand opens the same futures on a larger canvas.</p>
        <div className="engine-line">
          <span className={connected && health?.status === "ok" && health.runtime_running ? "dot ok" : connected ? "dot warn" : "dot bad"} />
          <span>{engineText(connected, health, healthError)}</span>
          <span className="count">{timelines.length}</span>
        </div>
        <TokenField />
      </footer>
      {expanded
        ? createPortal(
            <div className="graph-stage" role="dialog" aria-modal="true" aria-label="Expanded timeline graph">
              <div className="graph-stage-frame">
              <header className="graph-stage-head">
                <div>
                  <p className="brand-kicker">Timeline explorer</p>
                  <h2>Branching futures</h2>
                  <p className="panel-note">The same selection as the workspace. Closing this view leaves the running application unchanged.</p>
                </div>
                <button ref={closeRef} type="button" className="btn" onClick={() => setExpanded(false)}>
                  Close
                </button>
              </header>
              <TimelineCanvas expanded onExpand={() => setExpanded(false)} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function engineText(connected: boolean, health: { status: string; runtime_running: boolean } | null, healthError: string | null): string {
  if (!connected) return healthError ? "Engine offline" : "Connecting";
  if (!health) return "Engine offline";
  if (health.status === "ok" && health.runtime_running) return "Engine connected";
  if (!health.runtime_running) return "Runtime stopped";
  return `Engine ${health.status}`;
}

function TokenField() {
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(() => Boolean(getToken()));

  return (
    <form
      className="token"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (!next) return;
        setToken(next);
        setDraft("");
        setSaved(true);
      }}
    >
      <label htmlFor="engine-token">Engine token</label>
      <div className="token-row">
        <input
          id="engine-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={saved ? "Token saved" : "Optional"}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn" disabled={!draft.trim()}>
          Save
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setToken("");
            setDraft("");
            setSaved(false);
          }}
        >
          Clear
        </button>
      </div>
      <p>{saved ? "Stored in this browser. Sent on changes only." : "Leave empty when the engine has no token."}</p>
    </form>
  );
}
