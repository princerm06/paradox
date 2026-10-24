import { useWorkspace } from "../state/workspace.tsx";
import { BranchNavigator } from "./BranchNavigator.tsx";

export function TimelineExplorer({ onClose, onPick }: { onClose: () => void; onPick?: () => void }) {
  const { timelines, loading, listError, connected, health, healthError, reload } = useWorkspace();

  return (
    <aside className="futures-float" aria-label="Futures">
      <header className="futures-head">
        <div>
          <p className="brand-kicker">Explore</p>
          <h2>Futures</h2>
        </div>
        <button type="button" className="text-btn" onClick={onClose}>
          Hide
        </button>
      </header>
      <div
        className="futures-body"
        onClick={(event) => {
          if (onPick && event.target instanceof Element && event.target.closest(".branch-row")) onPick();
        }}
      >
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
        {timelines.length > 0 ? <BranchNavigator /> : null}
      </div>
      <footer className="futures-foot">
        <span className={connected && health?.status === "ok" && health.runtime_running ? "dot ok" : connected ? "dot warn" : "dot bad"} />
        <span>{engineText(connected, health, healthError)}</span>
      </footer>
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
