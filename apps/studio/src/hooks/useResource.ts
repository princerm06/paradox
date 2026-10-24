import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isAbort } from "../api/client.ts";

export type Resource<T> =
  | { status: "idle"; data: null; error: null }
  | { status: "loading"; data: T | null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

type Settled<T> = { key: string; data: T | null; error: string | null };

/**
 * Load `loader` whenever `key` changes. Results are stored with the key that
 * requested them and only surface while that key is still current, so a slow
 * response for a previous selection can never render under a newer one.
 * `refreshKey` reloads the same subject while keeping its last data visible.
 */
export function useResource<T>(
  key: string | null,
  loader: (signal: AbortSignal) => Promise<T>,
  refreshKey = "",
  fallback = "This evidence could not be loaded.",
): Resource<T> & { reload: () => void } {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    loaderRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ key, data, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setSettled({ key, data: null, error: errorMessage(error, fallback) });
      },
    );
    return () => controller.abort();
  }, [key, refreshKey, nonce, fallback]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  if (!key) return { status: "idle", data: null, error: null, reload };
  if (!settled || settled.key !== key) return { status: "loading", data: null, error: null, reload };
  if (settled.error !== null) return { status: "error", data: null, error: settled.error, reload };
  return { status: "ready", data: settled.data as T, error: null, reload };
}
