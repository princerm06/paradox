import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import type { Provider } from "../api/types.ts";
import { timelineById } from "../graph/tree.ts";
import { generationStageLabel, isTerminalGeneration } from "../lib/format.ts";
import { useWorkspace } from "../state/workspace.tsx";

export function PromptComposer() {
  const { timelines, generations, selectedId, selectedGenerationId, startGeneration, cancelGeneration } = useWorkspace();
  const [prompt, setPrompt] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);
  const [activateOnSuccess, setActivateOnSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.agents().then(
      (list) => {
        if (cancelled) return;
        const next = list.providers ?? [];
        setProviders(next);
        const available = next.filter((item) => item.available);
        const preferred = available.find((item) => item.id === list.default) ?? available[0];
        setProvider(preferred?.id ?? "");
      },
      (reason: unknown) => {
        if (!cancelled) setProviderError(reason instanceof ApiError ? reason.message : "Providers could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const ghost = generations.find((generation) => generation.id === selectedGenerationId) ?? null;
  const parent = timelineById(timelines, ghost ? ghost.parent_id : selectedId);
  const submission = generations.find((generation) => generation.id === submissionId) ?? null;
  const declined = parent?.status === "declined";
  const canGenerate = Boolean(prompt.trim() && parent && provider && !submitting && !declined);

  return (
    <form
      className="composer"
      aria-label="Future prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canGenerate || !parent) return;
        setSubmitting(true);
        setError(null);
        void startGeneration({
          parentId: parent.id,
          prompt: prompt.trim(),
          provider,
          activateOnSuccess,
        })
          .then((created) => setSubmissionId(created.id))
          .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : "The generation could not be started."))
          .finally(() => setSubmitting(false));
      }}
    >
      <div className="composer-copy">
        <p>What would you like to change?</p>
        <span>{parent ? `From ${parent.name}` : "Select a timeline to start from."}</span>
      </div>
      <textarea
        value={prompt}
        maxLength={4000}
        placeholder="Describe the change."
        aria-label="What would you like to change?"
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button type="submit" className="btn primary" disabled={!canGenerate}>
        {submitting ? "Starting" : "Generate future"}
      </button>
      <div className="composer-meta">
        <button type="button" className="text-btn" aria-expanded={optionsOpen} onClick={() => setOptionsOpen((open) => !open)}>
          {optionsOpen ? "Hide options" : "Options"}
        </button>
        {submission && !isTerminalGeneration(submission.status) ? (
          <span className="composer-status">
            {generationStageLabel(submission)}
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                void cancelGeneration(submission.id).catch((reason: unknown) => {
                  setError(reason instanceof ApiError ? reason.message : "The generation could not be cancelled.");
                });
              }}
            >
              Cancel
            </button>
          </span>
        ) : null}
        {declined ? <span>Declined timelines cannot start a generation.</span> : null}
        {error ? <span className="composer-error">{error}</span> : null}
        {providerError ? <span className="composer-error">{providerError}</span> : null}
      </div>
      {optionsOpen ? (
        <div className="composer-options">
          <label>
            Provider
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {providers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available} title={item.reason ?? undefined}>
                  {item.available ? item.id : `${item.id} unavailable`}
                </option>
              ))}
            </select>
          </label>
          <label className="check-label">
            <input type="checkbox" checked={activateOnSuccess} onChange={(event) => setActivateOnSuccess(event.target.checked)} />
            Activate when it succeeds
          </label>
        </div>
      ) : null}
    </form>
  );
}
