import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../api/client.ts";
import { isTerminalGeneration } from "../lib/format.ts";
import type { Generation, Health, Timeline } from "../api/types.ts";

type WorkspaceValue = {
  connected: boolean;
  health: Health | null;
  healthError: string | null;
  timelines: Timeline[];
  generations: Generation[];
  activeTimelineId: string | null;
  appUrl: string;
  selectedId: string | null;
  selectedGenerationId: string | null;
  loading: boolean;
  listError: string | null;
  previewNonce: number;
  selectTimeline: (id: string) => void;
  selectGeneration: (id: string) => void;
  startGeneration: (input: { parentId: string; prompt: string; provider: string; activateOnSuccess: boolean }) => Promise<Generation>;
  cancelGeneration: (id: string) => Promise<void>;
  refreshPreview: () => void;
  reload: () => void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Timeline[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [activeTimelineId, setActiveTimelineId] = useState<string | null>(null);
  const [appUrl, setAppUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const generationsRef = useRef<Generation[]>([]);
  const selectedGenerationRef = useRef<string | null>(null);
  generationsRef.current = generations;
  selectedGenerationRef.current = selectedGenerationId;
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  const applyTimelines = useCallback((next: Timeline[], activeId: string | null, url: string) => {
    setTimelines(next);
    setActiveTimelineId(activeId);
    setAppUrl(url);
    if (activeRef.current && activeId && activeRef.current !== activeId) {
      setPreviewNonce((value) => value + 1);
    }
    activeRef.current = activeId;
    setSelectedId((current) => {
      if (current && next.some((timeline) => timeline.id === current)) return current;
      return activeId && next.some((timeline) => timeline.id === activeId) ? activeId : next[0]?.id ?? null;
    });
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    void (async () => {
      try {
        const [healthResult, timelineResult] = await Promise.all([api.health(), api.timelines()]);
        setHealth(healthResult);
        setHealthError(null);
        setConnected(true);
        setListError(null);
        applyTimelines(timelineResult.timelines ?? [], timelineResult.active_timeline_id, timelineResult.app_url ?? "");
        try {
          const generationResult = await api.generations();
          setGenerations(generationResult.generations ?? []);
        } catch {
          /* Timeline navigation still works when the generation list cannot be loaded. */
        }
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "The Paradox engine is unreachable.";
        setConnected(false);
        setHealth(null);
        setHealthError(message);
        setListError(message);
      } finally {
        setLoading(false);
      }
    })();
  }, [applyTimelines]);

  useEffect(() => {
    reload();
    const healthTimer = window.setInterval(() => {
      void api.health().then(
        (next) => {
          setHealth(next);
          setHealthError(null);
          setConnected(true);
        },
        (error: unknown) => {
          const message = error instanceof ApiError ? error.message : "The Paradox engine is unreachable.";
          setHealth(null);
          setHealthError(message);
          setConnected(false);
        },
      );
    }, 5000);
    const listTimer = window.setInterval(() => {
      void api.timelines().then(
        (next) => {
          setListError(null);
          setConnected(true);
          applyTimelines(next.timelines ?? [], next.active_timeline_id, next.app_url ?? "");
        },
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 0) {
            setConnected(false);
            setListError(error.message);
          }
        },
      );
    }, 15000);
    return () => {
      window.clearInterval(healthTimer);
      window.clearInterval(listTimer);
    };
  }, [applyTimelines, reload]);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const timer = window.setInterval(() => {
      const active = generationsRef.current.filter((generation) => !isTerminalGeneration(generation.status));
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
              continue;
            }
            setGenerations((previous) => {
              const known = previous.find((item) => item.id === next.id);
              if (known && known.status === next.status && known.updated_at === next.updated_at && known.timeline_id === next.timeline_id && known.error?.stage === next.error?.stage) {
                return previous;
              }
              return previous.map((item) => (item.id === next.id ? next : item));
            });
            if (current.status === "succeeded" || next.status !== "succeeded" || !next.timeline_id) continue;
            const wasSelected = selectedGenerationRef.current === next.id;
            try {
              const list = await api.timelines();
              if (wasSelected) {
                setSelectedGenerationId(null);
                setSelectedId(next.timeline_id);
              }
              applyTimelines(list.timelines ?? [], list.active_timeline_id, list.app_url ?? "");
              setConnected(true);
              setListError(null);
            } catch (error) {
              if (error instanceof ApiError && error.status === 0) {
                setConnected(false);
                setListError(error.message);
              }
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
  }, [applyTimelines]);

  const selectTimeline = useCallback((id: string) => {
    setSelectedGenerationId(null);
    setSelectedId(id);
  }, []);

  const selectGeneration = useCallback((id: string) => {
    setSelectedGenerationId(id);
  }, []);

  const startGeneration = useCallback(async (input: { parentId: string; prompt: string; provider: string; activateOnSuccess: boolean }) => {
    const created = await api.createGeneration({
      parentId: input.parentId,
      prompt: input.prompt,
      provider: input.provider,
      activateOnSuccess: input.activateOnSuccess,
    });
    setGenerations((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
    setSelectedGenerationId(created.id);
    return created;
  }, []);

  const cancelGeneration = useCallback(async (id: string) => {
    const current = generationsRef.current.find((item) => item.id === id);
    if (!current || isTerminalGeneration(current.status)) return;
    const next = await api.cancelGeneration(id);
    setGenerations((previous) => previous.map((item) => (item.id === next.id ? next : item)));
  }, []);

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
      activeTimelineId,
      appUrl,
      selectedId,
      selectedGenerationId,
      loading,
      listError,
      previewNonce,
      selectTimeline,
      selectGeneration,
      startGeneration,
      cancelGeneration,
      refreshPreview,
      reload,
    }),
    [
      connected,
      health,
      healthError,
      timelines,
      generations,
      activeTimelineId,
      appUrl,
      selectedId,
      selectedGenerationId,
      loading,
      listError,
      previewNonce,
      selectTimeline,
      selectGeneration,
      startGeneration,
      cancelGeneration,
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
