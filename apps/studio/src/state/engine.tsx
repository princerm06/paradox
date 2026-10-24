import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createApi, migrateLegacyToken, type Api } from "../api/client.ts";
import { BASE_KEY, getApiBase, setApiBase } from "../api/config.ts";
import { readSession, writeSession } from "../lib/session.ts";

type EngineValue = {
  /** Effective engine base every request in this subtree is bound to. */
  base: string;
  api: Api;
  /** Persist a new engine URL (or "" for the build default). False when the URL is invalid. */
  switchEngine: (value: string) => boolean;
};

const EngineContext = createContext<EngineValue | null>(null);

/** Attribute the browser tests read to verify the studio's real request target. */
export const ENGINE_ATTRIBUTE = "data-paradox-engine";

/**
 * The engine identity boundary. Everything engine-specific (timelines,
 * generations, providers, evidence, selection, pending actions, polling) lives
 * below a subtree keyed by the effective base, so switching engines unmounts
 * all of it: in-flight responses from the old engine land on unmounted state
 * and are dropped, and no control can act on the previous engine.
 */
export function EngineProvider({ children }: { children: ReactNode }) {
  const [base, setBase] = useState(() => {
    migrateLegacyToken();
    return getApiBase();
  });
  const api = useMemo(() => createApi(base), [base]);

  const switchEngine = useCallback((value: string) => {
    if (!setApiBase(value)) return false;
    setBase(getApiBase());
    return true;
  }, []);

  // Another tab changed the stored engine: follow it so this tab never keeps
  // talking to an engine the browser no longer has configured.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BASE_KEY) setBase(getApiBase());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute(ENGINE_ATTRIBUTE, base);
  }, [base]);

  const value = useMemo(() => ({ base, api, switchEngine }), [api, base, switchEngine]);
  return (
    <EngineContext.Provider value={value}>
      <Fragment key={base}>{children}</Fragment>
    </EngineContext.Provider>
  );
}

export function useEngine(): EngineValue {
  const value = useContext(EngineContext);
  if (!value) throw new Error("useEngine must be used inside EngineProvider");
  return value;
}

export function useApi(): Api {
  return useEngine().api;
}

/**
 * Local UI context (not engine state) that should survive a refresh of this
 * tab: scoped per engine so one engine's selection never resurfaces on another.
 */
export function useSessionState(name: string): [string | null, (value: string | null) => void] {
  const { base } = useEngine();
  const [value, setValue] = useState<string | null>(() => readSession(base, name));
  const update = useCallback(
    (next: string | null) => {
      writeSession(base, name, next);
      setValue(next);
    },
    [base, name],
  );
  return [value, update];
}
