import type {
  AgentList,
  Detail,
  Generation,
  GenerationList,
  Health,
  LogStream,
  OpenApiDoc,
  Snapshot,
  SnapshotList,
  SproutModification,
  Timeline,
  TimelineList,
} from "./types.ts";
import { getApiBase, normalizeBase } from "./config.ts";

/** Pre-scoping key: a token saved here was not bound to any engine. */
const LEGACY_TOKEN_KEY = "paradox.token";
const TOKEN_PREFIX = "paradox.token:";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function tokenKey(base: string): string {
  return `${TOKEN_PREFIX}${normalizeBase(base) ?? base}`;
}

/**
 * Tokens are stored per engine base so a credential saved for one engine is
 * never attached to requests for another.
 */
export function getToken(base: string): string {
  try {
    return localStorage.getItem(tokenKey(base)) || "";
  } catch {
    return "";
  }
}

export function setToken(base: string, value: string): void {
  try {
    const next = String(value || "").trim();
    if (next) localStorage.setItem(tokenKey(base), next);
    else localStorage.removeItem(tokenKey(base));
  } catch {
    /* Private browsing can reject storage. Requests continue without a token. */
  }
}

/**
 * A token saved before tokens were scoped belongs to whichever engine the
 * browser was using then, which is the current effective base. Bind it there
 * once and drop the unscoped copy so it can never follow a later engine switch.
 */
export function migrateLegacyToken(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy === null) return;
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    const base = getApiBase();
    if (legacy.trim() && !getToken(base)) setToken(base, legacy);
  } catch {
    /* Nothing to migrate when storage is unavailable. */
  }
}

function statusLabel(status: number): string {
  if (status === 401) return "Unauthorized";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Invalid request";
  if (status === 503) return "Unavailable";
  if (status === 0) return "Offline";
  return status ? `Error ${status}` : "Error";
}

export function formatDetail(detail: Detail, status: number): string {
  let text = "";
  if (typeof detail === "string") {
    text = detail;
  } else if (Array.isArray(detail)) {
    text = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const where = Array.isArray(item.loc)
          ? item.loc.filter((part) => part !== "body" && part !== "query").join(".")
          : "";
        const msg = item.msg || item.message || "Invalid value";
        return where ? `${where}: ${msg}` : msg;
      })
      .filter(Boolean)
      .join(" ");
  } else if (detail && typeof detail === "object") {
    text = detail.message || detail.msg || "";
  }

  const label = statusLabel(status);
  if (!text) return label;
  return `${label}: ${text}`;
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
};

function authHeaders(base: string, method: string, hasBody: boolean): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  const token = getToken(base);
  if (token && method !== "GET" && method !== "HEAD") headers.Authorization = `Bearer ${token}`;
  return Object.keys(headers).length ? headers : undefined;
}

async function send(base: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  try {
    return await fetch(`${base}${path}`, {
      method,
      signal: options.signal,
      cache: "no-store",
      headers: authHeaders(base, method, options.body !== undefined),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, `Offline: Cannot reach the Paradox engine at ${base}.`);
  }
}

async function fail(response: Response, raw: string): Promise<never> {
  let detail: Detail = raw;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { detail?: Detail };
      detail = parsed.detail ?? raw;
    } catch {
      detail = raw;
    }
  }
  throw new ApiError(response.status, formatDetail(detail, response.status));
}

async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(base, path, options);
  const raw = await response.text();
  if (!response.ok) await fail(response, raw);
  if (!raw) return null as T;
  return JSON.parse(raw) as T;
}

async function requestText(base: string, path: string, signal?: AbortSignal): Promise<string> {
  const response = await send(base, path, { signal });
  const raw = await response.text();
  if (!response.ok) await fail(response, raw);
  return raw;
}

function timelinePath(id: string, suffix: string): string {
  return `/api/timelines/${encodeURIComponent(id)}${suffix}`;
}

function generationPath(id: string, suffix = ""): string {
  return `/api/generations/${encodeURIComponent(id)}${suffix}`;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * A client bound to one engine base. Every request, and the credential attached
 * to it, goes to that base only; switching engines means building a new client.
 */
export function createApi(base: string) {
  return {
    base,
    health(signal?: AbortSignal) {
      return request<Health>(base, "/api/health", { signal });
    },
    timelines(signal?: AbortSignal) {
      return request<TimelineList>(base, "/api/timelines", { signal });
    },
    sprout(input: { name: string; modification: SproutModification; parentId: string }) {
      return request<Timeline>(base, "/api/timelines/sprout", {
        method: "POST",
        body: { name: input.name, modification: input.modification, parent_id: input.parentId },
      });
    },
    activate(id: string) {
      return request<Timeline>(base, timelinePath(id, "/activate"), { method: "POST" });
    },
    confirm(id: string) {
      return request<Timeline>(base, timelinePath(id, "/confirm"), { method: "POST" });
    },
    decline(id: string) {
      return request<Timeline>(base, timelinePath(id, "/decline"), { method: "POST" });
    },
    /** FastAPI publishes its live schema here; used read-only by Architect. */
    openapi(signal?: AbortSignal) {
      return request<OpenApiDoc>(base, "/openapi.json", { signal });
    },
    snapshots(id: string, signal?: AbortSignal) {
      return request<SnapshotList>(base, timelinePath(id, "/snapshots"), { signal });
    },
    createSnapshot(id: string) {
      return request<Snapshot>(base, timelinePath(id, "/snapshots"), { method: "POST" });
    },
    restore(id: string, snapshotId: string) {
      return request<Timeline>(base, timelinePath(id, "/restore"), {
        method: "POST",
        body: { snapshot_id: snapshotId },
      });
    },
    agents(signal?: AbortSignal) {
      return request<AgentList>(base, "/api/agents", { signal });
    },
    generations(parentId?: string, signal?: AbortSignal) {
      const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : "";
      return request<GenerationList>(base, `/api/generations${query}`, { signal });
    },
    generation(id: string, signal?: AbortSignal) {
      return request<Generation>(base, generationPath(id), { signal });
    },
    createGeneration(input: {
      parentId: string;
      prompt: string;
      name?: string;
      provider: string;
      activateOnSuccess?: boolean;
    }) {
      // The provider is always explicit: the engine's own default may be a paid agent.
      if (!input.provider) return Promise.reject(new ApiError(422, "Invalid request: Choose an agent provider."));
      const body: Record<string, unknown> = {
        parent_id: input.parentId,
        prompt: input.prompt,
        provider: input.provider,
        activate_on_success: Boolean(input.activateOnSuccess),
      };
      if (input.name) body.name = input.name;
      return request<Generation>(base, "/api/generations", { method: "POST", body });
    },
    cancelGeneration(id: string) {
      return request<Generation>(base, generationPath(id, "/cancel"), { method: "POST" });
    },
    generationLogs(id: string, stream: "agent" | "validation" = "agent", tail = 200, signal?: AbortSignal) {
      const query = new URLSearchParams({ stream, tail: String(tail) });
      return request<LogStream>(base, `${generationPath(id, "/logs")}?${query}`, { signal });
    },
    generationDiff(id: string, signal?: AbortSignal) {
      return requestText(base, generationPath(id, "/diff"), signal);
    },
  };
}

export type Api = ReturnType<typeof createApi>;
