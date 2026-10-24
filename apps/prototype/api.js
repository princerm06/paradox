/**
 * Paradox engine client.
 *
 * All backend calls live here so the interface can move to Next.js later
 * without rewriting request or error handling. The UI should import `api`
 * and avoid calling fetch() against the engine directly.
 */

export const API_BASE = "http://127.0.0.1:8000";
const TOKEN_KEY = "paradox.token";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(value) {
  try {
    const next = String(value || "").trim();
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Private browsing can reject storage. The request still proceeds without a token. */
  }
}

function statusLabel(status) {
  if (status === 401) return "Unauthorized";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Invalid request";
  if (status === 503) return "Unavailable";
  if (status === 0) return "Offline";
  return status ? `Error ${status}` : "Error";
}

export function formatDetail(detail, status) {
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

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, { method = "GET", body, signal, text = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token && method !== "GET" && method !== "HEAD") headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      cache: "no-store",
      headers: Object.keys(headers).length ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    throw new ApiError(0, `Offline: Cannot reach the Paradox engine at ${API_BASE}.`);
  }

  if (text) {
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw;
      try {
        detail = JSON.parse(raw).detail;
      } catch {
        /* The body is already the message. */
      }
      throw new ApiError(response.status, formatDetail(detail, response.status));
    }
    return raw;
  }

  const payload = await readBody(response);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload.detail : payload;
    throw new ApiError(response.status, formatDetail(detail, response.status));
  }
  return payload;
}

function timelinePath(id, suffix) {
  return `/api/timelines/${encodeURIComponent(id)}${suffix}`;
}

function generationPath(id, suffix = "") {
  return `/api/generations/${encodeURIComponent(id)}${suffix}`;
}

export const api = {
  health(signal) {
    return request("/api/health", { signal });
  },
  timelines(signal) {
    return request("/api/timelines", { signal });
  },
  sprout({ name, modification, parentId }) {
    return request("/api/timelines/sprout", {
      method: "POST",
      body: {
        name,
        modification,
        parent_id: parentId,
      },
    });
  },
  activate(id) {
    return request(timelinePath(id, "/activate"), { method: "POST" });
  },
  confirm(id) {
    return request(timelinePath(id, "/confirm"), { method: "POST" });
  },
  decline(id) {
    return request(timelinePath(id, "/decline"), { method: "POST" });
  },
  snapshots(id, signal) {
    return request(timelinePath(id, "/snapshots"), { signal });
  },
  createSnapshot(id) {
    return request(timelinePath(id, "/snapshots"), { method: "POST" });
  },
  restore(id, snapshotId) {
    return request(timelinePath(id, "/restore"), {
      method: "POST",
      body: { snapshot_id: snapshotId },
    });
  },
  agents(signal) {
    return request("/api/agents", { signal });
  },
  generations(parentId, signal) {
    const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : "";
    return request(`/api/generations${query}`, { signal });
  },
  generation(id, signal) {
    return request(generationPath(id), { signal });
  },
  createGeneration({ parentId, prompt, name, provider, activateOnSuccess = false }) {
    const body = {
      parent_id: parentId,
      prompt,
      provider,
      activate_on_success: Boolean(activateOnSuccess),
    };
    if (name) body.name = name;
    return request("/api/generations", { method: "POST", body });
  },
  cancelGeneration(id) {
    return request(generationPath(id, "/cancel"), { method: "POST" });
  },
  generationLogs(id, stream = "agent", tail = 200, signal) {
    const query = new URLSearchParams({ stream, tail: String(tail) });
    return request(`${generationPath(id, "/logs")}?${query}`, { signal });
  },
  generationDiff(id, signal) {
    return request(generationPath(id, "/diff"), { signal, text: true });
  },
};
