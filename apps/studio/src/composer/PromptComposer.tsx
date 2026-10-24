import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../api/client.ts";
import type { AgentList, Generation } from "../api/types.ts";
import { timelineById } from "../graph/tree.ts";
import { Stepper } from "../inspector/FutureInspector.tsx";
import { generationStageLabel } from "../lib/format.ts";
import { generationPhase, isActiveGeneration } from "../lib/generation.ts";
import { initialProvider, isPaidProvider, prefersFreeProvider } from "../lib/providers.ts";
import { ConfirmDialog } from "../shell/ConfirmDialog.tsx";
import { useAskInspect } from "../shell/inspect.tsx";
import { useApi, useSessionState } from "../state/engine.tsx";
import { useWorkspace } from "../state/workspace.tsx";

type Providers = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; list: AgentList };

function useProviders(connected: boolean) {
  const api = useApi();
  const [state, setState] = useState<Providers>({ status: "loading" });
  const seq = useRef(0);
  const load = useCallback(() => {
    const token = ++seq.current;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    void api.agents().then(
      (list) => {
        if (token === seq.current) setState({ status: "ready", list });
      },
      (error: unknown) => {
        if (token === seq.current) setState({ status: "error", error: errorMessage(error, "Agent providers could not be loaded.") });
      },
    );
  }, [api]);
  // Recheck on first connect and every reconnect.
  useEffect(() => {
    if (connected) load();
  }, [connected, load]);
  return { state, reload: load };
}

export function PromptComposer() {
  const { timelines, generations, selectedId, selectedGenerationId, selectTimeline, selectGeneration, startGeneration, cancelGeneration, connected, activeTimelineId } = useWorkspace();
  const askInspect = useAskInspect();
  const ids = useId();
  const providers = useProviders(connected);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [activateOnSuccess, setActivateOnSuccess] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard: two clicks in one frame must never create two generations.
  const inFlight = useRef(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The submission strip is local UI state, restored per engine after a
  // refresh; the record it shows always comes from the engine.
  const [submissionId, setSubmissionId] = useSessionState("submission");
  const [restoredId] = useState(() => submissionId);
  const [adopted, setAdopted] = useState<string | null>(null);
  const [paidConfirm, setPaidConfirm] = useState(false);
  const [cancelState, setCancelState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const list = providers.state.status === "ready" ? providers.state.list : null;
  const available = list?.providers.filter((item) => item.available) ?? [];
  // Keep the chosen provider only while it stays available; otherwise start on
  // the safe initial choice (free scripted provider in development builds).
  useEffect(() => {
    if (!list) return;
    setProvider((current) => {
      if (current && list.providers.some((item) => item.id === current && item.available)) return current;
      return initialProvider(list, prefersFreeProvider());
    });
  }, [list]);

  const ghost = generations.find((generation) => generation.id === selectedGenerationId) ?? null;
  const parent = timelineById(timelines, ghost ? ghost.parent_id : selectedId);
  const submission: Generation | null = generations.find((generation) => generation.id === submissionId) ?? null;
  const running = generations.filter((generation) => isActiveGeneration(generation.status));

  // After a refresh (or when another tab started one), surface a generation
  // the engine reports as running so its progress and Cancel stay reachable.
  // This only reads engine state; nothing is ever resubmitted.
  const newestRunning = running[0]?.id ?? null;
  useEffect(() => {
    if (submission || !newestRunning) return;
    // A restored id may simply not be loaded yet.
    if (submissionId && !generations.length) return;
    setAdopted(newestRunning);
    setSubmissionId(newestRunning);
  }, [generations.length, newestRunning, setSubmissionId, submission, submissionId]);
  const origin = !submission ? null : adopted === submission.id ? "running" : restoredId === submission.id ? "restored" : null;
  const otherRunning = running.filter((generation) => generation.id !== submission?.id).length;
  const chosen = list?.providers.find((item) => item.id === provider) ?? null;
  const parentOptions = timelines.filter((timeline) => timeline.status !== "declined");

  const problems: string[] = [];
  if (!connected) problems.push("The engine is offline.");
  if (!parent) problems.push("Choose a parent future to branch from.");
  else if (parent.status === "declined") problems.push("Declined futures cannot be used as a parent.");
  if (providers.state.status === "error") problems.push(`Providers unavailable: ${providers.state.error}`);
  else if (list && available.length === 0) problems.push("No agent provider is available on this engine.");
  else if (list && !chosen?.available) problems.push("Choose an available provider.");
  if (!prompt.trim()) problems.push("Describe the change you want.");
  const ready = problems.length === 0 && !submitting && providers.state.status === "ready";

  const submit = (paidConfirmed = false) => {
    setAttempted(true);
    if (!ready || !parent || inFlight.current) return;
    // A paid agent never runs from a stray click or ⌘↵.
    if (isPaidProvider(provider) && !paidConfirmed) {
      setPaidConfirm(true);
      return;
    }
    setPaidConfirm(false);
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    setCancelState({ busy: false, error: null });
    void startGeneration({ parentId: parent.id, prompt: prompt.trim(), provider, name: name.trim() || undefined, activateOnSuccess })
      .then((created) => {
        setAdopted(null);
        setSubmissionId(created.id);
        setPrompt("");
        setName("");
        setAttempted(false);
        // Back to the safe default after every submission.
        setActivateOnSuccess(false);
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason, "The generation could not be started."));
        // The engine may have changed provider availability; recheck.
        providers.reload();
      })
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
  };

  const phase = submission ? generationPhase(submission.status) : null;

  return (
    <form
      className="composer"
      aria-label="Generate a future"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composer-main">
        <span className="composer-glyph" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
            <path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6Z" />
          </svg>
        </span>
        <label htmlFor={`${ids}-prompt`} className="sr-only">
          What would you like to change?
        </label>
        <textarea
          id={`${ids}-prompt`}
          value={prompt}
          maxLength={4000}
          rows={1}
          placeholder="What would you like to change?"
          aria-describedby={`${ids}-status`}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className={activateOnSuccess ? "btn primary go-live" : "btn primary"} disabled={submitting || (attempted && !ready)} aria-busy={submitting}>
          {submitting ? "Starting…" : activateOnSuccess ? "Generate & go live" : "Generate future"}
          <span className="kbd" aria-hidden="true">
            ⌘↵
          </span>
        </button>
      </div>

      <div className="composer-bar">
        <label className="chip-select">
          <span className="chip-label">From</span>
          <select
            value={parent && parent.status !== "declined" ? parent.id : ""}
            onChange={(event) => event.target.value && selectTimeline(event.target.value)}
            aria-label="Parent future"
          >
            {!parent || parent.status === "declined" ? <option value="">Choose a parent</option> : null}
            {parentOptions.map((timeline) => (
              <option key={timeline.id} value={timeline.id}>
                {timeline.name}
                {timeline.id === activeTimelineId ? " (live)" : ""}
              </option>
            ))}
          </select>
        </label>
        <ProviderChip state={providers.state} provider={provider} onProvider={setProvider} onRecheck={providers.reload} />
        <fieldset className="activation" aria-describedby={`${ids}-activation`}>
          <legend className="sr-only">After validation passes</legend>
          <label className={!activateOnSuccess ? "seg is-on" : "seg"}>
            <input type="radio" name={`${ids}-activate`} checked={!activateOnSuccess} onChange={() => setActivateOnSuccess(false)} />
            Keep live
          </label>
          <label className={activateOnSuccess ? "seg is-on warn" : "seg"}>
            <input type="radio" name={`${ids}-activate`} checked={activateOnSuccess} onChange={() => setActivateOnSuccess(true)} />
            Go live on success
          </label>
        </fieldset>
        <button type="button" className="text-btn" aria-expanded={optionsOpen} aria-controls={`${ids}-options`} onClick={() => setOptionsOpen((open) => !open)}>
          {optionsOpen ? "Less" : "Name"}
        </button>
      </div>

      {optionsOpen ? (
        <div className="composer-options" id={`${ids}-options`}>
          <label>
            Future name <span className="fine">optional · engine defaults to the first 60 characters of the prompt</span>
            <input type="text" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="e.g. Popularity ranking" />
          </label>
        </div>
      ) : null}

      <div className="composer-status" id={`${ids}-status`} aria-live="polite">
        <p id={`${ids}-activation`} className={activateOnSuccess ? "warn-text" : "sr-only"}>
          {activateOnSuccess
            ? "If all six validation checks pass, the engine switches the running app to this future without asking again."
            : "The new future stays inactive. You decide later whether to make it live."}
        </p>
        {attempted && problems.length > 0 ? <p className="composer-error">{problems[0]}</p> : null}
        {error ? <p className="composer-error">{error}</p> : null}
        {submission ? (
          <div className={`submission phase-${phase}`}>
            <div className="submission-head">
              <strong title={submission.name}>{submission.name}</strong>
              <span className="fine">{generationStageLabel(submission)}</span>
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  if (submission.timeline_id && phase === "succeeded" && timelineById(timelines, submission.timeline_id)) selectTimeline(submission.timeline_id);
                  else selectGeneration(submission.id);
                  askInspect();
                }}
              >
                Inspect
              </button>
              {phase === "active" ? (
                <button
                  type="button"
                  className="text-btn danger-text"
                  disabled={cancelState.busy}
                  onClick={() => {
                    setCancelState({ busy: true, error: null });
                    void cancelGeneration(submission.id).then(
                      () => setCancelState({ busy: false, error: null }),
                      (reason: unknown) => setCancelState({ busy: false, error: errorMessage(reason, "The generation could not be cancelled.") }),
                    );
                  }}
                >
                  {cancelState.busy ? "Cancelling…" : "Cancel"}
                </button>
              ) : (
                <button type="button" className="text-btn" onClick={() => setSubmissionId(null)} aria-label="Dismiss result">
                  Dismiss
                </button>
              )}
            </div>
            {origin ? (
              <p className="fine submission-origin">
                {origin === "running"
                  ? `Running on the engine${submission.provider ? ` · ${submission.provider}` : ""}. Reattached after reload; nothing was resubmitted.`
                  : "Restored after reload from the engine's record."}
              </p>
            ) : null}
            {phase === "active" || phase === "failed" || phase === "cancelled" ? <Stepper generation={submission} /> : null}
            {phase === "succeeded" ? (
              <p className="fine">
                {submission.activate_on_success ? "Validated and made live by the engine." : "Validated. The new future is pending; make it live from the inspector when ready."}
              </p>
            ) : null}
            {submission.error?.message ? <p className="composer-error">{submission.error.message}</p> : null}
            {cancelState.error ? <p className="composer-error">{cancelState.error}</p> : null}
            {otherRunning ? <p className="fine">{otherRunning === 1 ? "1 more generation is" : `${otherRunning} more generations are`} running. Find them as ghosts on the canvas.</p> : null}
          </div>
        ) : null}
        {chosen && chosen.available && isPaidProvider(chosen.id) ? (
          <p className="warn-text">{chosen.id} may consume paid agent credits. You will be asked to confirm before it runs.</p>
        ) : null}
      </div>
      {paidConfirm && parent ? (
        <ConfirmDialog
          title={`Run a paid ${provider} generation?`}
          confirmLabel={`Generate with ${provider}`}
          tone="live"
          onCancel={() => setPaidConfirm(false)}
          onConfirm={() => submit(true)}
        >
          <p>
            The <strong>{provider}</strong> agent may consume paid credits on the engine's account. The free <strong>scripted</strong> provider
            {list?.providers.some((item) => item.id === "scripted" && item.available) ? " is available for testing." : " is not available on this engine."}
          </p>
          <p>
            Branches from <strong>{parent.name}</strong>. Nothing is sent until you confirm.
          </p>
        </ConfirmDialog>
      ) : null}
    </form>
  );
}

function ProviderChip({
  state,
  provider,
  onProvider,
  onRecheck,
}: {
  state: Providers;
  provider: string;
  onProvider: (id: string) => void;
  onRecheck: () => void;
}) {
  if (state.status === "loading") {
    return (
      <span className="chip-select is-muted">
        <span className="dot" /> Checking agents…
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <button type="button" className="chip-select is-bad" onClick={onRecheck} title={state.error}>
        <span className="dot bad" /> Agents unavailable · Retry
      </button>
    );
  }
  const current = state.list.providers.find((item) => item.id === provider);
  const any = state.list.providers.some((item) => item.available);
  return (
    <label className={any ? "chip-select" : "chip-select is-bad"} title={current?.reason ?? (current ? `${current.id} is ready` : undefined)}>
      <span className={current?.available ? "dot ok" : "dot bad"} aria-hidden="true" />
      <span className="chip-label">Agent</span>
      <select value={provider} onChange={(event) => onProvider(event.target.value)} aria-label="Agent provider">
        {!any ? <option value="">None available</option> : null}
        {state.list.providers.map((item) => (
          <option key={item.id} value={item.id} disabled={!item.available}>
            {item.id}
            {item.id === state.list.default ? " (engine default)" : ""}
            {item.available && isPaidProvider(item.id) ? " · paid" : ""}
            {item.available ? "" : ` — ${item.reason ?? "unavailable"}`}
          </option>
        ))}
      </select>
    </label>
  );
}
