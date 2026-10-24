import type {
  AgentList,
  Detail,
  Generation,
  GenerationList,
  Health,
  LogStream,
  Snapshot,
  SnapshotList,
  SproutModification,
  Timeline,
  TimelineList,
} from "./types.ts";

export const API_BASE = "http://127.0.0.1:8000";
const TOKEN_KEY = "paradox.token";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(value: string): void {
  try {
    const next = String(value || "").trim();
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Private browsing can reject storage. Requests continue without a token. */
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

function authHeaders(method: string, hasBody: boolean): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token && method !== "GET" && method !== "HEAD") headers.Authorization = `Bearer ${token}`;
  return Object.keys(headers).length ? headers : undefined;
}

async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      signal: options.signal,
      cache: "no-store",
      headers: authHeaders(method, options.body !== undefined),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, `Offline: Cannot reach the Paradox engine at ${API_BASE}.`);
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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  const raw = await response.text();
  if (!response.ok) await fail(response, raw);
  if (!raw) return null as T;
  return JSON.parse(raw) as T;
}

async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  const response = await send(path, { signal });
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

export const api = {
  health(signal?: AbortSignal) {
    return request<Health>("/api/health", { signal });
  },
  timelines(signal?: AbortSignal) {
    return request<TimelineList>("/api/timelines", { signal });
  },
  sprout(input: { name: string; modification: SproutModification; parentId: string }) {
    return request<Timeline>("/api/timelines/sprout", {
      method: "POST",
      body: { name: input.name, modification: input.modification, parent_id: input.parentId },
    });
  },
  activate(id: string) {
    return request<Timeline>(timelinePath(id, "/activate"), { method: "POST" });
  },
  confirm(id: string) {
    return request<Timeline>(timelinePath(id, "/confirm"), { method: "POST" });
  },
  decline(id: string) {
    return request<Timeline>(timelinePath(id, "/decline"), { method: "POST" });
  },
  snapshots(id: string, signal?: AbortSignal) {
    return request<SnapshotList>(timelinePath(id, "/snapshots"), { signal });
  },
  createSnapshot(id: string) {
    return request<Snapshot>(timelinePath(id, "/snapshots"), { method: "POST" });
  },
  restore(id: string, snapshotId: string) {
    return request<Timeline>(timelinePath(id, "/restore"), {
      method: "POST",
      body: { snapshot_id: snapshotId },
    });
  },
  agents(signal?: AbortSignal) {
    return request<AgentList>("/api/agents", { signal });
  },
  generations(parentId?: string, signal?: AbortSignal) {
    const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : "";
    return request<GenerationList>(`/api/generations${query}`, { signal });
  },
  generation(id: string, signal?: AbortSignal) {
    return request<Generation>(generationPath(id), { signal });
  },
  createGeneration(input: {
    parentId: string;
    prompt: string;
    name?: string;
    provider: string;
    activateOnSuccess?: boolean;
  }) {
    const body: Record<string, unknown> = {
      parent_id: input.parentId,
      prompt: input.prompt,
      provider: input.provider,
      activate_on_success: Boolean(input.activateOnSuccess),
    };
    if (input.name) body.name = input.name;
    return request<Generation>("/api/generations", { method: "POST", body });
  },
  cancelGeneration(id: string) {
    return request<Generation>(generationPath(id, "/cancel"), { method: "POST" });
  },
  generationLogs(id: string, stream: "agent" | "validation" = "agent", tail = 200, signal?: AbortSignal) {
    const query = new URLSearchParams({ stream, tail: String(tail) });
    return request<LogStream>(`${generationPath(id, "/logs")}?${query}`, { signal });
  },
  generationDiff(id: string, signal?: AbortSignal) {
    return requestText(generationPath(id, "/diff"), signal);
  },
};
