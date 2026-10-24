import { useCallback } from "react";
import { useEngine } from "../state/engine.tsx";
import type { Generation, LogStream, OpenApiDoc, SnapshotList } from "../api/types.ts";
import { useResource } from "./useResource.ts";

export const ANALYSIS_LOG_TAIL = 2000;

// Every key carries the engine base: ids are only unique within one engine.

export function useGenerationDiff(generationId: string | null, version: string) {
  const { api, base } = useEngine();
  const load = useCallback((signal: AbortSignal) => api.generationDiff(generationId as string, signal), [api, generationId]);
  return useResource<string>(generationId ? `${base}|diff:${generationId}` : null, load, version, "The diff could not be loaded.");
}

export function useGenerationLogs(generationId: string | null, stream: "agent" | "validation", version: string, tail = 400) {
  const { api, base } = useEngine();
  const load = useCallback(
    (signal: AbortSignal) => api.generationLogs(generationId as string, stream, tail, signal),
    [api, generationId, stream, tail],
  );
  return useResource<LogStream>(generationId ? `${base}|logs:${stream}:${tail}:${generationId}` : null, load, version, `The ${stream} log could not be loaded.`);
}

export function useSnapshots(timelineId: string | null, version: string) {
  const { api, base } = useEngine();
  const load = useCallback((signal: AbortSignal) => api.snapshots(timelineId as string, signal), [api, timelineId]);
  return useResource<SnapshotList>(timelineId ? `${base}|snapshots:${timelineId}` : null, load, version, "Snapshots could not be loaded.");
}

export function useOpenApi(version: string) {
  const { api, base } = useEngine();
  const load = useCallback((signal: AbortSignal) => api.openapi(signal), [api]);
  return useResource<OpenApiDoc>(`${base}|openapi`, load, version, "The engine did not publish an OpenAPI schema.");
}

/**
 * A generation record: the workspace list copy when present (kept fresh by
 * polling), otherwise fetched once by id (e.g. the list failed to load).
 */
export function useGenerationRecord(generationId: string | null, known: Generation | null) {
  const { api, base } = useEngine();
  const load = useCallback((signal: AbortSignal) => api.generation(generationId as string, signal), [api, generationId]);
  const fetched = useResource<Generation>(generationId && !known ? `${base}|generation:${generationId}` : null, load, "", "The generation record could not be loaded.");
  if (known) return { record: known, status: "ready" as const, error: null, reload: fetched.reload };
  return { record: fetched.data, status: fetched.status, error: fetched.error, reload: fetched.reload };
}
