import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import { isActiveGeneration } from "../lib/generation.ts";
import { readSession, writeSession } from "../lib/session.ts";
import { useEngine } from "./engine.tsx";
import type { Generation, Health, Timeline, TimelineList } from "../api/types.ts";

export type RuntimeActionKind = "activate" | "confirm" | "decline" | "snapshot" | "restore";
export type PendingAction = { kind: RuntimeActionKind; timelineId: string; snapshotId?: string };

export type StartGenerationInput = {
  parentId: string;
  prompt: string;
  provider: string;
  name?: string;
  activateOnSuccess: boolean;
};

type WorkspaceValue = {
  connected: boolean;
  health: Health | null;
  healthError: string | null;
  timelines: Timeline[];
  generations: Generation[];
  generationsError: string | null;
  /** True once at least one generation list has been received from the engine. */
  generationsLoaded: boolean;
  activeTimelineId: string | null;
  appUrl: string;
  selectedId: string | null;
  selectedGenerationId: string | null;
  loading: boolean;
  /** True once at least one timeline list has been received from the engine. */
  loaded: boolean;
  listError: string | null;
  previewNonce: number;
  /** Bumps whenever a backend mutation may have created or consumed snapshots. */
  snapshotNonce: number;
  pendingAction: PendingAction | null;
  selectTimeline: (id: string) => void;
  selectGeneration: (id: string) => void;
  startGeneration: (input: StartGenerationInput) => Promise<Generation>;
  cancelGeneration: (id: string) => Promise<Generation | null>;
  runAction: (action: PendingAction) => Promise<void>;
  refreshPreview: () => void;
  reload: () => void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/** True when `next` is at least as fresh as `known` by the engine's own clock. */
export function isFresher(next: Generation, known: Generation | undefined): boolean {
  if (!known) return true;
  return (next.updated_at || "") >= (known.updated_at || "");
}

/** Merge a fetched batch into the known list without letting stale records regress newer ones. */
export function mergeGenerations(previous: Generation[], incoming: Generation[], authoritative: boolean): Generation[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  let changed = false;
  for (const next of incoming) {
    const known = byId.get(next.id);
    if (known && (!isFresher(next, known) || sameGeneration(known, next))) continue;
    byId.set(next.id, next);
    changed = true;
  }
  if (authoritative) {
    // A full list is authoritative for membership, except records we just created
    // or polled that the list request may have raced past.
    const incomingIds = new Set(incoming.map((item) => item.id));
    for (const item of previous) {
      if (!incomingIds.has(item.id) && !isActiveGeneration(item.status)) {
        byId.delete(item.id);
        changed = true;
      }
    }
  }
  if (!changed) return previous;
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}

function sameGeneration(a: Generation, b: Generation): boolean {
  return a.status === b.status && a.updated_at === b.updated_at && a.timeline_id === b.timeline_id && a.error?.stage === b.error?.stage;
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // Bound to one engine: EngineProvider remounts this provider when the engine
  // changes, so none of the state below ever mixes two engines.
  const { api, base } = useEngine();
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Timeline[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [generationsError, setGenerationsError] = useState<string | null>(null);
  const [generationsLoaded, setGenerationsLoaded] = useState(false);
  const [activeTimelineId, setActiveTimelineId] = useState<string | null>(null);
  const [appUrl, setAppUrl] = useState("");
  // Selection is local UI state; it is restored per engine after a refresh but
  // only kept once the engine confirms the record still exists.
  const [selectedId, setSelectedId] = useState<string | null>(() => readSession(base, "selected"));
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(() => readSession(base, "selectedGeneration"));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [snapshotNonce, setSnapshotNonce] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const activeRef = useRef<string | null>(null);
  const generationsRef = useRef<Generation[]>([]);
  const selectedGenerationRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);
  const connectedRef = useRef(false);
  // Monotonic tokens so a slow, older /api/timelines response can never
  // overwrite a newer one (e.g. a poll that started before an activation).
  const listRequested = useRef(0);
  const listApplied = useRef(0);
  const generationsRequested = useRef(0);
  const generationsApplied = useRef(0);
  generationsRef.current = generations;
  selectedGenerationRef.current = selectedGenerationId;
  connectedRef.current = connected;

  const applyTimelines = useCallback((list: TimelineList, token: number) => {
    if (token < listApplied.current) return false;
    listApplied.current = token;
    const next = list.timelines ?? [];
    const activeId = list.active_timeline_id ?? null;
    setTimelines(next);
    setActiveTimelineId(activeId);
    setAppUrl(list.app_url ?? "");
    setLoaded(true);
    if (activeRef.current && activeId && activeRef.current !== activeId) {
      setPreviewNonce((value) => value + 1);
    }
    activeRef.current = activeId;
    setSelectedId((current) => {
      if (current && next.some((timeline) => timeline.id === current)) return current;
      return activeId && next.some((timeline) => timeline.id === activeId) ? activeId : next[0]?.id ?? null;
    });
    return true;
  }, []);

  useEffect(() => writeSession(base, "selected", selectedId), [base, selectedId]);
  useEffect(() => writeSession(base, "selectedGeneration", selectedGenerationId), [base, selectedGenerationId]);

  const fetchTimelines = useCallback(async () => {
    const token = ++listRequested.current;
    const list = await api.timelines();
    applyTimelines(list, token);
    setListError(null);
    setConnected(true);
    return list;
  }, [api, applyTimelines]);

  const fetchGenerations = useCallback(async () => {
    const token = ++generationsRequested.current;
    try {
      const result = await api.generations();
      if (token < generationsApplied.current) return;
      generationsApplied.current = token;
      const incoming = result.generations ?? [];
      setGenerations((previous) => mergeGenerations(previous, incoming, true));
      // A selection restored from a previous page load may name a record this
      // engine no longer has.
      setSelectedGenerationId((current) => (current && !incoming.some((item) => item.id === current) && !generationsRef.current.some((item) => item.id === current) ? null : current));
      setGenerationsError(null);
      setGenerationsLoaded(true);
    } catch (error) {
      if (token < generationsApplied.current) return;
      setGenerationsError(message(error, "Generation records could not be loaded."));
    }
  }, [api]);

  const markOffline = useCallback((error: unknown) => {
    const text = message(error, "The Paradox engine is unreachable.");
    setConnected(false);
    setHealth(null);
    setHealthError(text);
    setListError(text);
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    void (async () => {
      try {
        const [healthResult] = await Promise.all([api.health(), fetchTimelines()]);
        setHealth(healthResult);
        setHealthError(null);
        await fetchGenerations();
      } catch (error) {
        markOffline(error);
      } finally {
        setLoading(false);
      }
    })();
  }, [api, fetchGenerations, fetchTimelines, markOffline]);

  useEffect(() => {
    reload();
    const healthTimer = window.setInterval(() => {
      const wasConnected = connectedRef.current;
      void api.health().then(
        (next) => {
          setHealth(next);
          setHealthError(null);
          setConnected(true);
          // Reconnected after an outage: refresh everything the outage may have hidden.
          if (!wasConnected) reload();
        },
        (error: unknown) => {
          const text = message(error, "The Paradox engine is unreachable.");
          setHealth(null);
          setHealthError(text);
          setConnected(false);
        },
      );
    }, 5000);
    const listTimer = window.setInterval(() => {
      if (!connectedRef.current) return;
      void fetchTimelines().then(
        () => fetchGenerations(),
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 0) markOffline(error);
        },
      );
    }, 15000);
    return () => {
      window.clearInterval(healthTimer);
      window.clearInterval(listTimer);
    };
  }, [api, fetchGenerations, fetchTimelines, markOffline, reload]);

  // Poll in-flight generations about once a second (M2 contract). Unknown
  // statuses are deliberately not polled as if they were running.
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const timer = window.setInterval(() => {
      const active = generationsRef.current.filter((generation) => isActiveGeneration(generation.status));
      if (!active.length || busy) return;
      busy = true;
      void (async () => {
        try {
          for (const current of active) {
            if (stopped) return;
            let next: Generation;
            try {
              next = await api.generation(current.id);
            } catch (error) {
              if (error instanceof ApiError && error.status === 0) {
                setConnected(false);
                setHealthError(error.message);
                break;
              }
              // The engine no longer knows this run (e.g. restarted on other
              // state): stop showing it as running instead of polling forever.
              if (error instanceof ApiError && error.status === 404 && !stopped) {
                setGenerations((previous) => previous.filter((item) => item.id !== current.id));
              }
              continue;
            }
            if (stopped) return;
            setGenerations((previous) => mergeGenerations(previous, [next], false));
            if (next.status !== "succeeded" || !next.timeline_id) continue;
            const wasSelected = selectedGenerationRef.current === next.id;
            try {
              await fetchTimelines();
              if (stopped) return;
              // Follow the selection from the ghost to the timeline it produced,
              // but only if the user is still looking at that ghost.
              if (wasSelected && selectedGenerationRef.current === next.id) {
                setSelectedGenerationId(null);
                setSelectedId(next.timeline_id);
              }
              setSnapshotNonce((value) => value + 1);
            } catch (error) {
              if (error instanceof ApiError && error.status === 0) markOffline(error);
            }
          }
        } finally {
          busy = false;
        }
      })();
    }, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [api, fetchTimelines, markOffline]);

  const selectTimeline = useCallback((id: string) => {
    setSelectedGenerationId(null);
    setSelectedId(id);
  }, []);

  const selectGeneration = useCallback((id: string) => {
    setSelectedGenerationId(id);
  }, []);

  const startGeneration = useCallback(async (input: StartGenerationInput) => {
    const created = await api.createGeneration({
      parentId: input.parentId,
      prompt: input.prompt,
      provider: input.provider,
      name: input.name?.trim() || undefined,
      activateOnSuccess: input.activateOnSuccess,
    });
    if (!created || typeof created.id !== "string") throw new Error("The engine's response did not include the generation record.");
    setGenerations((previous) => mergeGenerations(previous, [created], false));
    setSelectedGenerationId(created.id);
    return created;
  }, [api]);

  const cancelGeneration = useCallback(async (id: string) => {
    const current = generationsRef.current.find((item) => item.id === id);
    if (!current || !isActiveGeneration(current.status)) return null;
    try {
      const next = await api.cancelGeneration(id);
      setGenerations((previous) => mergeGenerations(previous, [next], false));
      return next;
    } catch (error) {
      // 409 means it reached a terminal state first; show the engine's truth.
      try {
        const latest = await api.generation(id);
        setGenerations((previous) => mergeGenerations(previous, [latest], false));
      } catch {
        /* Keep the original error. */
      }
      throw error;
    }
  }, [api]);

  const runAction = useCallback(
    async (action: PendingAction) => {
      if (pendingRef.current) throw new ApiError(409, "Conflict: Another runtime action is still running.");
      pendingRef.current = action;
      setPendingAction(action);
      try {
        if (action.kind === "activate") await api.activate(action.timelineId);
        else if (action.kind === "confirm") await api.confirm(action.timelineId);
        else if (action.kind === "decline") await api.decline(action.timelineId);
        else if (action.kind === "snapshot") await api.createSnapshot(action.timelineId);
        else if (action.kind === "restore") {
          if (!action.snapshotId) throw new ApiError(422, "Invalid request: Choose a snapshot to restore.");
          await api.restore(action.timelineId, action.snapshotId);
        }
      } finally {
        // Success or failure, the engine is the authority on what is live now
        // (a failed transition may have rolled back). Refetch before releasing.
        try {
          const [nextHealth] = await Promise.all([api.health(), fetchTimelines()]);
          setHealth(nextHealth);
          setHealthError(null);
        } catch (error) {
          if (error instanceof ApiError && error.status === 0) markOffline(error);
        }
        setSnapshotNonce((value) => value + 1);
        if (action.kind === "restore" || action.kind === "activate") setPreviewNonce((value) => value + 1);
        pendingRef.current = null;
        setPendingAction(null);
      }
    },
    [api, fetchTimelines, markOffline],
  );

  const refreshPreview = useCallback(() => {
    setPreviewNonce((value) => value + 1);
  }, []);

  const value = useMemo<WorkspaceValue>(
    () => ({
      connected,
      health,
      healthError,
      timelines,
      generations,
      generationsError,
      generationsLoaded,
      activeTimelineId,
      appUrl,
      selectedId,
      selectedGenerationId,
      loading,
      loaded,
      listError,
      previewNonce,
      snapshotNonce,
      pendingAction,
      selectTimeline,
      selectGeneration,
      startGeneration,
      cancelGeneration,
      runAction,
      refreshPreview,
      reload,
    }),
    [
      connected,
      health,
      healthError,
      timelines,
      generations,
      generationsError,
      generationsLoaded,
      activeTimelineId,
      appUrl,
      selectedId,
      selectedGenerationId,
      loading,
      loaded,
      listError,
      previewNonce,
      snapshotNonce,
      pendingAction,
      selectTimeline,
      selectGeneration,
      startGeneration,
      cancelGeneration,
      runAction,
      refreshPreview,
      reload,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
