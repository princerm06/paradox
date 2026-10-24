import { useEffect, useState } from "react";
import { errorMessage } from "../api/client.ts";
import type { Snapshot, Timeline } from "../api/types.ts";
import { timelineById } from "../graph/tree.ts";
import { formatStamp } from "../lib/format.ts";
import { ConfirmDialog } from "../shell/ConfirmDialog.tsx";
import { useWorkspace, type PendingAction, type RuntimeActionKind } from "../state/workspace.tsx";

type Draft = { kind: RuntimeActionKind; timeline: Timeline; snapshot?: Snapshot };
type Outcome = { timelineId: string; tone: "ok" | "error"; text: string };

const ACTION_LABEL: Record<RuntimeActionKind, string> = {
  activate: "Make live",
  confirm: "Confirm",
  decline: "Decline",
  snapshot: "Save snapshot",
  restore: "Restore",
};

/** Nearest non-declined ancestor, mirroring the engine's documented decline rule. */
function fallbackAncestor(timelines: Timeline[], timeline: Timeline): Timeline | null {
  let current = timelineById(timelines, timeline.parent_id);
  const seen = new Set<string>();
  while (current && current.status === "declined" && !seen.has(current.id)) {
    seen.add(current.id);
    current = timelineById(timelines, current.parent_id);
  }
  return current;
}

export function useRuntimeAction() {
  const { runAction, pendingAction, timelines, activeTimelineId } = useWorkspace();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  const execute = async (next: Draft) => {
    const action: PendingAction = { kind: next.kind, timelineId: next.timeline.id, snapshotId: next.snapshot?.id };
    setBusy(true);
    setDialogError(null);
    try {
      await runAction(action);
      setDraft(null);
      setOutcome({ timelineId: next.timeline.id, tone: "ok", text: successText(next) });
    } catch (error) {
      const text = errorMessage(error, "The engine rejected this action.");
      if (draft) setDialogError(text);
      else setOutcome({ timelineId: next.timeline.id, tone: "error", text });
    } finally {
      setBusy(false);
    }
  };

  const request = (kind: RuntimeActionKind, timeline: Timeline, snapshot?: Snapshot) => {
    setOutcome(null);
    setDialogError(null);
    const next = { kind, timeline, snapshot };
    // Saving a snapshot replaces nothing; every other action asks first.
    if (kind === "snapshot") void execute(next);
    else setDraft(next);
  };

  const dialog = draft ? (
    <ConfirmDialog
      title={dialogTitle(draft)}
      confirmLabel={dialogConfirm(draft)}
      tone={draft.kind === "decline" ? "danger" : draft.kind === "confirm" ? "default" : "live"}
      busy={busy}
      error={dialogError}
      onCancel={() => {
        if (busy) return;
        setDraft(null);
        setDialogError(null);
      }}
      onConfirm={() => void execute(draft)}
    >
      <DialogCopy draft={draft} timelines={timelines} activeTimelineId={activeTimelineId} />
    </ConfirmDialog>
  ) : null;

  return { request, dialog, outcome, pendingAction, busy, clearOutcome: () => setOutcome(null) };
}

function successText(draft: Draft): string {
  switch (draft.kind) {
    case "activate":
      return `Engine confirmed: ${draft.timeline.name} is live.`;
    case "confirm":
      return `Engine confirmed ${draft.timeline.name}.`;
    case "decline":
      return `Engine declined ${draft.timeline.name}.`;
    case "snapshot":
      return "Engine saved a snapshot of the live code and data.";
    case "restore":
      return `Engine restored the snapshot; ${draft.timeline.name} is live.`;
  }
}

function dialogTitle(draft: Draft): string {
  switch (draft.kind) {
    case "activate":
      return `Make ${draft.timeline.name} live?`;
    case "confirm":
      return `Confirm ${draft.timeline.name}?`;
    case "decline":
      return `Decline ${draft.timeline.name}?`;
    case "restore":
      return `Restore this snapshot of ${draft.timeline.name}?`;
    default:
      return ACTION_LABEL[draft.kind];
  }
}

function dialogConfirm(draft: Draft): string {
  if (draft.kind === "activate") return "Switch runtime";
  if (draft.kind === "restore") return "Restore and go live";
  return ACTION_LABEL[draft.kind];
}

function DialogCopy({ draft, timelines, activeTimelineId }: { draft: Draft; timelines: Timeline[]; activeTimelineId: string | null }) {
  const active = timelineById(timelines, activeTimelineId);
  const activeName = active ? active.name : "the current live future";
  const isLive = draft.timeline.id === activeTimelineId;
  if (draft.kind === "activate") {
    return (
      <>
        <p>
          The running application switches from <strong>{activeName}</strong> to <strong>{draft.timeline.name}</strong>.
        </p>
        <ul>
          <li>The engine first saves {activeName}'s current code and data as a new snapshot.</li>
          <li>It then restores {draft.timeline.name}'s latest snapshot and restarts the runtime.</li>
          <li>The live portal reloads only after the engine confirms the switch.</li>
        </ul>
      </>
    );
  }
  if (draft.kind === "confirm") {
    return (
      <>
        <p>Confirming keeps this future in the working history. It does not merge code and does not change what is live.</p>
        <p>Decisions are final: the engine will not let a confirmed future be declined later.</p>
      </>
    );
  }
  if (draft.kind === "decline") {
    const fallback = fallbackAncestor(timelines, draft.timeline);
    return (
      <>
        <p>Declining archives this future. Its snapshots are kept for reference, but it can no longer be activated, restored or used as a parent.</p>
        {isLive ? (
          <p className="dialog-warn">
            It is live right now, so the engine will switch the runtime back to <strong>{fallback ? fallback.name : "the nearest non-declined ancestor"}</strong>.
          </p>
        ) : (
          <p>The live application is not affected.</p>
        )}
        <p>This decision is final.</p>
      </>
    );
  }
  if (draft.kind === "restore" && draft.snapshot) {
    return (
      <>
        <p>
          Restores <strong>{draft.timeline.name}</strong> to its snapshot from <strong>{formatStamp(draft.snapshot.created_at)}</strong> and makes it live.
        </p>
        <ul>
          <li>The engine first saves {isLive ? "this future's" : `${activeName}'s`} current code and data as a new snapshot, even when restoring the live future.</li>
          <li>Code and data return to the moment of the snapshot; changes since then remain recoverable from that new snapshot.</li>
          {!isLive ? <li>The runtime switches from {activeName} to {draft.timeline.name}.</li> : null}
        </ul>
      </>
    );
  }
  return null;
}

/** The action bar for a selected timeline. Disabled reasons come from the engine's documented rules. */
export function TimelineActions({ timeline }: { timeline: Timeline }) {
  const { activeTimelineId, connected, health } = useWorkspace();
  const { request, dialog, outcome, pendingAction, busy } = useRuntimeAction();
  const isLive = timeline.id === activeTimelineId;
  const declined = timeline.status === "declined";
  const pending = timeline.status === "pending" && Boolean(timeline.parent_id);
  const blocked = !connected || Boolean(pendingAction) || busy;
  const runtimeStopped = isLive && health ? !health.runtime_running : false;
  const working = pendingAction?.timelineId === timeline.id ? pendingAction.kind : null;
  const [visibleOutcome, setVisibleOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    setVisibleOutcome(outcome);
  }, [outcome]);

  useEffect(() => {
    if (visibleOutcome?.tone !== "ok") return;
    const timer = window.setTimeout(() => setVisibleOutcome(null), 6000);
    return () => window.clearTimeout(timer);
  }, [visibleOutcome]);

  const reason = !connected
    ? "Engine offline."
    : pendingAction && pendingAction.timelineId !== timeline.id
      ? "Another runtime action is running."
      : null;

  return (
    <div className="runtime-actions">
      <div className="action-row" role="group" aria-label={`Actions for ${timeline.name}`}>
        {isLive && !runtimeStopped ? (
          <span className="live-note">
            <span className="state-live-dot" aria-hidden="true" />
            Serving the runtime
          </span>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={blocked || declined}
            title={declined ? "Declined futures cannot be activated." : undefined}
            onClick={() => request("activate", timeline)}
          >
            {working === "activate" ? "Switching…" : runtimeStopped ? "Start runtime" : "Make live"}
          </button>
        )}
        {pending ? (
          <>
            <button type="button" className="btn" disabled={blocked} onClick={() => request("confirm", timeline)}>
              {working === "confirm" ? "Confirming…" : "Confirm"}
            </button>
            <button type="button" className="btn ghost-danger" disabled={blocked} onClick={() => request("decline", timeline)}>
              {working === "decline" ? "Declining…" : "Decline"}
            </button>
          </>
        ) : null}
        {isLive ? (
          <button
            type="button"
            className="btn"
            disabled={blocked}
            title="Briefly stops the runtime to capture its code and data, then restarts it."
            onClick={() => request("snapshot", timeline)}
          >
            {working === "snapshot" ? "Saving…" : "Save snapshot"}
          </button>
        ) : null}
      </div>
      {reason ? <p className="action-reason">{reason}</p> : null}
      {declined ? <p className="action-reason">Declined: kept for reference only.</p> : null}
      {visibleOutcome && visibleOutcome.timelineId === timeline.id ? (
        <p className={visibleOutcome.tone === "ok" ? "action-ok" : "inspector-error"} role="status">
          {visibleOutcome.text}
        </p>
      ) : null}
      {dialog}
    </div>
  );
}
