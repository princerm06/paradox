const DEFAULT_BASE = "http://127.0.0.1:8000";
/** localStorage key for the per-browser engine override set in Settings. */
export const BASE_KEY = "paradox.apiBase";

/** Absolute http(s) origin (+ optional path) without credentials, query or fragment. */
export function normalizeBase(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Build-time default: `VITE_PARADOX_API_BASE`, else the engine's documented local default. */
export function defaultApiBase(): string {
  const fromEnv = normalizeBase(String(import.meta.env?.VITE_PARADOX_API_BASE ?? ""));
  return fromEnv ?? DEFAULT_BASE;
}

/** A per-browser override (Settings) wins over the build-time default. */
export function getApiBase(): string {
  try {
    const stored = normalizeBase(localStorage.getItem(BASE_KEY) || "");
    if (stored) return stored;
  } catch {
    /* Storage can be unavailable; fall back to the default. */
  }
  return defaultApiBase();
}

export function setApiBase(value: string): boolean {
  try {
    if (!String(value || "").trim()) {
      localStorage.removeItem(BASE_KEY);
      return true;
    }
    const next = normalizeBase(value);
    if (!next) return false;
    if (next === defaultApiBase()) localStorage.removeItem(BASE_KEY);
    else localStorage.setItem(BASE_KEY, next);
    return true;
  } catch {
    return false;
  }
}

export function hasApiBaseOverride(): boolean {
  try {
    return Boolean(normalizeBase(localStorage.getItem(BASE_KEY) || ""));
  } catch {
    return false;
  }
}
