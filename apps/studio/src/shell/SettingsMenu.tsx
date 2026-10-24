import { useEffect, useRef, useState } from "react";
import { getToken, setToken } from "../api/client.ts";
import { defaultApiBase, hasApiBaseOverride, normalizeBase } from "../api/config.ts";
import { isActiveGeneration } from "../lib/generation.ts";
import { useEngine } from "../state/engine.tsx";
import { useWorkspace } from "../state/workspace.tsx";

export function SettingsMenu() {
  const { connected, health, healthError } = useWorkspace();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div className="settings" ref={rootRef}>
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        Settings
      </button>
      {open ? (
        <div className="settings-popover" role="dialog" aria-label="Studio settings">
          <p className="settings-status">{connectionDetail(connected, health, healthError)}</p>
          <EngineField />
          <TokenField />
        </div>
      ) : null}
    </div>
  );
}

function connectionDetail(
  connected: boolean,
  health: { status: string; runtime_running: boolean } | null,
  healthError: string | null,
): string {
  if (!connected) return healthError ?? "The engine is not reachable.";
  if (!health) return "Waiting for engine health.";
  if (health.status === "ok" && health.runtime_running) return "Engine connected. Runtime is serving the active future.";
  if (!health.runtime_running) return "Engine connected. Runtime is stopped.";
  return `Engine status: ${health.status}.`;
}

function TokenField() {
  const { base } = useEngine();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(() => Boolean(getToken(base)));

  return (
    <form
      className="token"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (!next) return;
        setToken(base, next);
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
            setToken(base, "");
            setDraft("");
            setSaved(false);
          }}
        >
          Clear
        </button>
      </div>
      <p>{saved ? `Stored in this browser for ${base} only. Sent on changes only.` : "Leave empty when the engine has no token. Tokens are kept per engine URL."}</p>
    </form>
  );
}

function EngineField() {
  const { base, switchEngine } = useEngine();
  const { pendingAction, generations } = useWorkspace();
  const [draft, setDraft] = useState(base);
  const [error, setError] = useState<string | null>(null);
  const custom = hasApiBaseOverride();
  const running = generations.filter((item) => isActiveGeneration(item.status)).length;
  // A runtime action in flight belongs to this engine; switching mid-action
  // would hide its outcome.
  const locked = Boolean(pendingAction);
  const unchanged = (normalizeBase(draft) ?? draft.trim()) === base;
  // Switching remounts everything engine-specific, including this menu.
  return (
    <form
      className="token"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked) return;
        if (!switchEngine(draft)) setError("Enter an absolute http(s) URL without credentials, query or fragment.");
      }}
    >
      <label htmlFor="engine-url">Engine URL</label>
      <div className="token-row">
        <input id="engine-url" type="url" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="btn" disabled={locked || unchanged}>
          Use
        </button>
        <button type="button" className="btn" disabled={locked || !custom} onClick={() => switchEngine("")}>
          Reset
        </button>
      </div>
      <p>
        {error ??
          (locked
            ? "Wait for the current runtime action to finish before switching engines."
            : custom
              ? `Overrides the build default ${defaultApiBase()}.`
              : "Build default. Set VITE_PARADOX_API_BASE to change it.")}
      </p>
      {running && !locked ? <p>{running === 1 ? "1 generation is" : `${running} generations are`} still running on this engine. Switching does not cancel them.</p> : null}
    </form>
  );
}
