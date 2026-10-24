/**
 * Paradox workspace.
 *
 * State, graph rendering, and view updates are separated from api.js so this
 * file can later split into React components without changing the engine client.
 */

import { API_BASE, api } from "./api.js";

const NODE_W = 236;
const NODE_H = 90;
const GAP_X = 86;
const GAP_Y = 28;
const SVG_NS = "http://www.w3.org/2000/svg";

const MODIFICATIONS = {
  popular_feed: {
    label: "Popular feed",
    short: "Popular",
    summary: "Rank the feed by likes, then recency.",
    detail:
      "Sprouting copies the selected parent, replaces feed ranking with popularity order, and activates the child. The parent timeline stays unchanged.",
  },
  none: {
    label: "Unchanged fork",
    short: "Unchanged",
    summary: "Inherit the parent with no new edit.",
    detail:
      "The child is isolated and starts from the parent’s saved code and data. No new ranking change is applied. A child of a popular timeline still records modification “none” even when it inherits popularity ranking.",
  },
};

const NAV = [
  { id: "workspace", label: "Workspace", key: "1", icon: "workspace" },
  { id: "timelines", label: "Timelines", key: "2", icon: "timelines" },
  { id: "compare", label: "Compare", key: "3", icon: "compare" },
  { id: "activity", label: "Activity", key: "4", icon: "activity" },
  { id: "settings", label: "Settings", key: "5", icon: "settings" },
];

const state = {
  view: "workspace",
  health: null,
  healthError: null,
  connected: false,
  notedDisconnect: false,
  timelines: [],
  activeTimelineId: null,
  appUrl: "",
  selectedId: null,
  listError: null,
  bootstrapped: false,
  loadingTimelines: true,
  snapshotsById: {},
  snapshotStatus: {},
  snapshotError: {},
  snapshotToken: {},
  ordering: { timelineId: null, value: null, error: null },
  busy: false,
  transition: null,
  graph: { panX: 40, panY: 48, zoom: 1, userAdjusted: false },
  layout: null,
  seenNodeIds: new Set(),
  didFitOnce: false,
  needsFit: false,
  panToId: null,
  preview: { height: 288, expanded: false, loading: true, error: false, generation: 0, timer: 0 },
  composer: { open: false, name: "", parentId: "", modification: "popular_feed", nameTouched: false, error: "" },
  dialog: null,
  toasts: [],
  activity: [],
  compare: { leftId: "", rightId: "" },
  collapsed: { overview: false, modification: false, snapshots: false, runtime: false, evaluation: false },
  detailsOpen: false,
  previousFocus: null,
};

const resizeObserver = new ResizeObserver(() => {
  if (state.graph.userAdjusted || state.view !== "workspace") return;
  fitGraph({ animate: false });
});

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isNarrow() {
  return window.matchMedia("(max-width: 1180px)").matches;
}

function isTyping(event) {
  const tag = event.target && event.target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatFull(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || "Unknown time");
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatRelative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : "—";
}

function byId(id) {
  return state.timelines.find((timeline) => timeline.id === id) || null;
}

function childrenOf(id) {
  return state.timelines
    .filter((timeline) => timeline.parent_id === id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function ancestry(id) {
  const chain = [];
  const seen = new Set();
  let current = byId(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent_id ? byId(current.parent_id) : null;
  }
  return chain;
}

function activeTimeline() {
  return byId(state.activeTimelineId);
}

function selectedTimeline() {
  return byId(state.selectedId);
}

function modificationLabel(value) {
  if (value === "popular_feed") return MODIFICATIONS.popular_feed.label;
  if (value === "none") return MODIFICATIONS.none.label;
  if (value == null || value === "") return "None recorded";
  return String(value);
}

function modificationShort(value) {
  if (value === "popular_feed") return MODIFICATIONS.popular_feed.short;
  if (value === "none") return MODIFICATIONS.none.short;
  if (value == null || value === "") return "Origin";
  return String(value);
}

function statusLabel(timeline) {
  if (!timeline) return "Unknown";
  if (!timeline.parent_id) return "Root";
  if (timeline.status === "pending") return "Pending";
  if (timeline.status === "confirmed") return "Confirmed";
  if (timeline.status === "declined") return "Declined";
  return timeline.status || "Unknown";
}

function canDecide(timeline) {
  return Boolean(timeline && timeline.parent_id && timeline.status === "pending");
}

function canEnter(timeline) {
  return Boolean(timeline && timeline.status !== "declined" && !timeline.is_active);
}

function canSproutFrom(timeline) {
  return Boolean(timeline && timeline.status !== "declined");
}

function canCheckpoint(timeline) {
  return Boolean(timeline && timeline.is_active && timeline.status !== "declined");
}

function canRestore(timeline) {
  return Boolean(timeline && timeline.status !== "declined");
}

function enterReason(timeline) {
  if (state.busy) return "Wait for the current transition to finish.";
  if (!timeline) return "Select a timeline first.";
  if (timeline.status === "declined") return "Declined timelines stay archived and cannot be entered.";
  if (timeline.is_active) return "This timeline is already the live runtime.";
  return "";
}

function decideReason(timeline) {
  if (state.busy) return "Wait for the current transition to finish.";
  if (!timeline) return "Select a timeline first.";
  if (!timeline.parent_id) return "The root timeline is already confirmed and cannot be declined.";
  if (timeline.status === "confirmed") return "This future is already confirmed. Decisions cannot be changed.";
  if (timeline.status === "declined") return "This future is already declined. Decisions cannot be changed.";
  if (timeline.status !== "pending") return "Only pending futures can be confirmed or declined.";
  return "";
}

function parentReturnReason(timeline) {
  if (!timeline) return "Select a timeline first.";
  if (!timeline.parent_id) return "This timeline has no parent.";
  const parent = byId(timeline.parent_id);
  if (!parent) return "The parent timeline is not available.";
  if (parent.status === "declined") return "The parent is declined and cannot be entered.";
  if (parent.is_active) return "The parent timeline is already live.";
  return enterReason(parent);
}

function icon(name) {
  const paths = {
    logo: '<path d="M6 18V9.5"/><path d="M6 9.5C9.2 9.5 10.4 5 12.4 5"/><path d="M6 9.5C9.6 9.5 11.4 13.2 16.4 13.2"/><circle cx="6" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.4" cy="5" r="1.35"/><circle cx="16.4" cy="13.2" r="1.35"/>',
    workspace: '<circle cx="6" cy="16" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="18" cy="13" r="1.6"/><path d="M6 16V9M6 9c3 0 4-3 6-3M6 9c3.2 0 5.2 4 12 4"/>',
    timelines: '<circle cx="6" cy="7" r="1.7"/><circle cx="6" cy="17" r="1.7"/><circle cx="17" cy="12" r="1.7"/><path d="M6 8.8v6.4M7.6 7.8C10 9 13 10.2 15.2 11.2"/>',
    compare: '<rect x="4" y="5" width="6.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="6.5" height="14" rx="1.5"/>',
    activity: '<path d="M4 12h3l2-4 3 8 2-4h6"/>',
    settings: '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>',
    refresh: '<path d="M19 12a7 7 0 1 1-1.6-4.4"/><path d="M19 5v4h-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    enter: '<path d="M5 12h11"/><path d="M12 7l5 5-5 5"/><path d="M19 6v12"/>',
    back: '<path d="M19 12H8"/><path d="M12 7 7 12l5 5"/>',
    check: '<path d="M5 12.5 9.2 17 19 7"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
    zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 20 20M11 8.5v5M8.5 11h5"/>',
    zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 20 20M8.5 11h5"/>',
    fit: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    collapse: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>',
    alert: '<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M12 4 3.5 19h17L12 4z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}

function setStatus(message) {
  const region = document.getElementById("sr-status");
  if (region) region.textContent = message;
}

function logActivity(level, message) {
  state.activity.unshift({ id: uid(), level, message, at: new Date().toISOString() });
  if (state.activity.length > 100) state.activity.length = 100;
}

function dismissToast(id) {
  state.toasts = state.toasts.filter((toast) => toast.id !== id);
  renderToasts();
}

function toast(level, message) {
  const id = uid();
  state.toasts = [...state.toasts, { id, level, message }].slice(-4);
  renderToasts();
  window.setTimeout(() => dismissToast(id), level === "error" ? 7200 : 4600);
}

function note(level, message) {
  logActivity(level, message);
  toast(level, message);
  setStatus(message);
}

function syncChrome() {
  const app = document.getElementById("app");
  app.classList.toggle("is-busy", state.busy);
  app.classList.toggle("preview-expanded", state.preview.expanded);
  app.classList.toggle("details-open", state.detailsOpen);
  app.style.setProperty("--preview-h", `${state.preview.height}px`);
  app.setAttribute("aria-busy", state.busy ? "true" : "false");
  const resizer = document.getElementById("preview-resizer");
  if (resizer) resizer.setAttribute("aria-valuenow", String(Math.round(state.preview.height)));
}

function preferredParent() {
  const selected = selectedTimeline();
  if (canSproutFrom(selected)) return selected;
  const active = activeTimeline();
  if (canSproutFrom(active)) return active;
  return state.timelines.find((timeline) => timeline.status !== "declined") || null;
}

function baseName(modification) {
  return modification === "none" ? "Unchanged fork" : "Popular feed";
}

function suggestName(modification) {
  const base = baseName(modification);
  const names = new Set(state.timelines.map((timeline) => timeline.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function layoutTimelines(timelines) {
  const ids = new Set(timelines.map((timeline) => timeline.id));
  const children = new Map();
  const roots = [];
  for (const timeline of timelines) {
    if (timeline.parent_id && ids.has(timeline.parent_id)) {
      if (!children.has(timeline.parent_id)) children.set(timeline.parent_id, []);
      children.get(timeline.parent_id).push(timeline);
    } else {
      roots.push(timeline);
    }
  }
  const sortFn = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  roots.sort(sortFn);
  for (const list of children.values()) list.sort(sortFn);

  const positions = new Map();
  let cursor = 0;
  const walk = (node, depth) => {
    const kids = children.get(node.id) || [];
    let center;
    if (!kids.length) {
      center = cursor + NODE_H / 2;
      cursor += NODE_H + GAP_Y;
    } else {
      const centers = kids.map((kid) => walk(kid, depth + 1));
      center = (centers[0] + centers[centers.length - 1]) / 2;
    }
    positions.set(node.id, { x: depth * (NODE_W + GAP_X), y: center - NODE_H / 2 });
    return center;
  };

  if (!roots.length) {
    return { positions, children, roots, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
  }
  for (const root of roots) walk(root, 0);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pos of positions.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + NODE_W);
    maxY = Math.max(maxY, pos.y + NODE_H);
  }
  return { positions, children, roots, bounds: { minX, minY, maxX, maxY } };
}

function applyTimelineList(data, { fromMutation = false } = {}) {
  const previousActive = state.activeTimelineId;
  const previousUrl = state.appUrl;
  state.timelines = Array.isArray(data.timelines) ? data.timelines : [];
  state.activeTimelineId = data.active_timeline_id || null;
  state.appUrl = typeof data.app_url === "string" ? data.app_url : "";
  state.listError = null;
  if (!state.selectedId || !byId(state.selectedId)) state.selectedId = state.activeTimelineId;
  const changed = previousActive !== state.activeTimelineId || (previousUrl && previousUrl !== state.appUrl);
  if (changed && !fromMutation && state.bootstrapped) bumpPreview();
  if (!state.didFitOnce && state.timelines.length) state.needsFit = true;
}

function mergeTimeline(timeline) {
  if (!timeline || !timeline.id) return;
  const index = state.timelines.findIndex((item) => item.id === timeline.id);
  if (index === -1) state.timelines.push(timeline);
  else state.timelines[index] = { ...state.timelines[index], ...timeline };
  if (timeline.is_active) {
    state.activeTimelineId = timeline.id;
    for (const item of state.timelines) item.is_active = item.id === timeline.id;
  }
}

async function refreshHealth({ quiet = false } = {}) {
  try {
    state.health = await api.health();
    state.healthError = null;
    const wasConnected = state.connected;
    state.connected = true;
    if (state.bootstrapped && !wasConnected && state.notedDisconnect) {
      state.notedDisconnect = false;
      note("success", "Engine connection restored.");
    }
  } catch (error) {
    state.health = null;
    state.healthError = error.message || "The engine is unreachable.";
    state.connected = false;
    if (state.bootstrapped && !state.notedDisconnect) {
      state.notedDisconnect = true;
      note("error", state.healthError);
    }
  }
  if (!quiet) renderNow();
}

async function refreshTimelines({ quiet = false, fromMutation = false } = {}) {
  state.loadingTimelines = !state.timelines.length;
  let ok = false;
  try {
    const data = await api.timelines();
    applyTimelineList(data, { fromMutation });
    state.connected = true;
    ok = true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    state.listError = error.message || "Timelines could not be loaded.";
    if (error.status === 0) state.connected = false;
  } finally {
    state.loadingTimelines = false;
  }
  if (!quiet) renderNow();
  return ok;
}

async function refreshOrdering() {
  if (!state.appUrl || !state.activeTimelineId) return;
  const timelineId = state.activeTimelineId;
  try {
    const response = await fetch(`${state.appUrl}api/posts`, { cache: "no-store" });
    if (!response.ok) throw new Error(`The live app returned ${response.status}.`);
    const data = await response.json();
    const next = { timelineId, value: data.ordering || null, error: data.ordering ? null : "The live app did not report ordering." };
    const unchanged = state.ordering.timelineId === next.timelineId && state.ordering.value === next.value && state.ordering.error === next.error;
    state.ordering = next;
    if (unchanged) return;
  } catch (error) {
    const next = { timelineId, value: null, error: error.message || "Ordering is unavailable." };
    const unchanged = state.ordering.timelineId === next.timelineId && state.ordering.value === next.value && state.ordering.error === next.error;
    state.ordering = next;
    if (unchanged) return;
  }
  renderNow();
}

async function refreshAll() {
  await Promise.all([refreshHealth({ quiet: true }), refreshTimelines({ quiet: true })]);
  if (state.selectedId) ensureSnapshot(state.selectedId, true);
  bumpPreview();
  renderNow();
}

function ensureSnapshot(id, force = false) {
  if (!id) return;
  if (!force && (state.snapshotStatus[id] === "loading" || state.snapshotStatus[id] === "ready")) return;
  const token = (state.snapshotToken[id] || 0) + 1;
  state.snapshotToken[id] = token;
  state.snapshotStatus[id] = "loading";
  api.snapshots(id).then((data) => {
    if (state.snapshotToken[id] !== token) return;
    state.snapshotsById[id] = Array.isArray(data.snapshots) ? data.snapshots : [];
    state.snapshotStatus[id] = "ready";
    delete state.snapshotError[id];
    renderNow();
  }).catch((error) => {
    if (error.name === "AbortError" || state.snapshotToken[id] !== token) return;
    state.snapshotStatus[id] = "error";
    state.snapshotError[id] = error.message || "Snapshots could not be loaded.";
    renderNow();
  });
}

function invalidateSnapshots() {
  state.snapshotsById = {};
  state.snapshotStatus = {};
  state.snapshotToken = {};
}

function bumpPreview() {
  window.clearTimeout(state.preview.timer);
  state.preview.generation += 1;
  state.preview.loading = Boolean(state.appUrl);
  state.preview.error = !state.appUrl;
}

function armPreviewTimeout() {
  window.clearTimeout(state.preview.timer);
  const generation = state.preview.generation;
  state.preview.timer = window.setTimeout(() => {
    if (state.preview.generation !== generation || !state.preview.loading) return;
    state.preview.loading = false;
    state.preview.error = true;
    updatePreviewVeil();
  }, 15000);
}

async function runMutation(options) {
  if (state.busy) return null;
  state.busy = true;
  state.transition = options.transition || null;
  renderNow();
  let result = null;
  try {
    result = await options.work();
    const refreshed = await refreshTimelines({ quiet: true, fromMutation: true });
    if (!refreshed) {
      mergeTimeline(result);
      note("error", "The action succeeded, but refreshing timelines failed.");
    }
    try {
      await refreshHealth({ quiet: true });
    } catch {
      /* Health is shown from the last successful read. */
    }
    if (options.after) options.after(result);
    invalidateSnapshots();
    if (state.selectedId) ensureSnapshot(state.selectedId, true);
    if (state.view === "compare") {
      ensureSnapshot(state.compare.leftId, true);
      ensureSnapshot(state.compare.rightId, true);
    }
    if (options.reloadPreview) bumpPreview();
    if (options.success) note("success", options.success(result));
    return result;
  } catch (error) {
    const message = error.message || "The action failed.";
    if (options.onError) options.onError(error);
    else note("error", message);
    return null;
  } finally {
    state.busy = false;
    state.transition = null;
    renderNow();
  }
}

function selectTimeline(id, { pan = false } = {}) {
  if (!id || !byId(id)) return;
  state.selectedId = id;
  if (isNarrow()) state.detailsOpen = true;
  ensureSnapshot(id);
  if (pan) state.panToId = id;
  renderNow();
  const node = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (node) node.focus({ preventScroll: true });
}

function openComposer(parentId) {
  const parent = (parentId && canSproutFrom(byId(parentId)) && byId(parentId)) || preferredParent();
  if (!parent) {
    note("error", "There is no timeline available to sprout from.");
    return;
  }
  state.previousFocus = document.activeElement;
  state.composer = {
    open: true,
    name: suggestName("popular_feed"),
    parentId: parent.id,
    modification: "popular_feed",
    nameTouched: false,
    error: "",
  };
  renderNow();
  document.getElementById("future-name")?.focus();
}

function setModification(modification) {
  if (!MODIFICATIONS[modification]) return;
  state.composer.modification = modification;
  if (!state.composer.nameTouched) state.composer.name = suggestName(modification);
  renderNow();
  document.querySelector(`[data-modification="${modification}"]`)?.focus();
}

async function submitComposer(event) {
  event.preventDefault();
  if (state.busy) return;
  const name = state.composer.name.trim();
  const parent = byId(state.composer.parentId);
  if (!name || name.length > 120) {
    state.composer.error = "Enter a future name between 1 and 120 characters.";
    renderNow();
    return;
  }
  if (!canSproutFrom(parent)) {
    state.composer.error = "Choose a timeline that has not been declined.";
    renderNow();
    return;
  }
  const modification = state.composer.modification;
  const created = await runMutation({
    transition: {
      title: "Sprouting future",
      detail: `Checkpointing the live timeline, then starting “${name}”.`,
    },
    work: () => api.sprout({ name, modification, parentId: parent.id }),
    reloadPreview: true,
    after: (timeline) => {
      state.composer.open = false;
      state.view = "workspace";
      if (timeline && timeline.id) {
        state.selectedId = timeline.id;
        state.panToId = timeline.id;
      }
    },
    success: (timeline) => `“${timeline?.name || name}” is live. The graph and preview now show that future.`,
    onError: (error) => {
      state.composer.error = error.message || "The future could not be created.";
      note("error", state.composer.error);
    },
  });
  if (created) state.composer.error = "";
}

async function enterTimeline(id) {
  const timeline = byId(id);
  const reason = enterReason(timeline);
  if (reason) {
    if (timeline && timeline.is_active) toast("info", reason);
    else if (reason) toast("error", reason);
    return;
  }
  await runMutation({
    transition: {
      title: "Entering future",
      detail: `Restoring “${timeline.name}” and restarting the runtime.`,
    },
    work: () => api.activate(timeline.id),
    reloadPreview: true,
    after: () => {
      state.selectedId = timeline.id;
      state.panToId = timeline.id;
    },
    success: () => `Entered “${timeline.name}”. The previous timeline was checkpointed first.`,
  });
}

async function returnToParent() {
  const timeline = selectedTimeline();
  const reason = parentReturnReason(timeline);
  if (!timeline || !timeline.parent_id) {
    toast("info", reason || "This timeline has no parent.");
    return;
  }
  const parent = byId(timeline.parent_id);
  if (!parent || parent.status === "declined") {
    toast("error", reason);
    return;
  }
  if (parent.is_active) {
    selectTimeline(parent.id, { pan: true });
    toast("info", "The parent timeline is already live. It is selected, and the runtime was left unchanged.");
    return;
  }
  await enterTimeline(parent.id);
}

async function confirmTimeline(id) {
  const timeline = byId(id);
  const reason = decideReason(timeline);
  if (reason) {
    toast("info", reason);
    return;
  }
  await runMutation({
    work: () => api.confirm(timeline.id),
    success: () => `Confirmed “${timeline.name}”. It stays available and was not merged into the original project.`,
  });
}

function askDecline(id) {
  const timeline = byId(id);
  const reason = decideReason(timeline);
  if (reason) {
    toast("info", reason);
    return;
  }
  state.previousFocus = document.activeElement;
  state.dialog = { kind: "decline", timelineId: timeline.id };
  renderNow();
  document.getElementById("dialog-cancel")?.focus();
}

function askRestore(timelineId, snapshotId) {
  const timeline = byId(timelineId);
  const snapshots = state.snapshotsById[timelineId] || [];
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!timeline || !snapshot) return;
  if (!canRestore(timeline)) {
    toast("error", "Declined timelines cannot be restored.");
    return;
  }
  state.previousFocus = document.activeElement;
  state.dialog = { kind: "restore", timelineId, snapshotId };
  renderNow();
  document.getElementById("dialog-cancel")?.focus();
}

async function confirmDialog() {
  const dialog = state.dialog;
  if (!dialog || state.busy) return;
  state.dialog = null;
  if (dialog.kind === "decline") {
    const timeline = byId(dialog.timelineId);
    if (!timeline) return;
    const wasActive = Boolean(timeline.is_active);
    await runMutation({
      transition: wasActive
        ? {
            title: "Archiving future",
            detail: `Declining “${timeline.name}” and returning to the nearest available ancestor.`,
          }
        : null,
      work: () => api.decline(timeline.id),
      reloadPreview: wasActive,
      after: () => {
        if (wasActive) {
          state.selectedId = state.activeTimelineId;
          state.panToId = state.activeTimelineId;
        }
      },
      success: () => {
        const landed = activeTimeline();
        const fallback = wasActive && landed ? ` The live runtime is now “${landed.name}”.` : "";
        return `Declined “${timeline.name}”. It remains archived on the graph, and its descendants were not declined.${fallback}`;
      },
    });
    return;
  }
  if (dialog.kind === "restore") {
    const timeline = byId(dialog.timelineId);
    if (!timeline) return;
    await runMutation({
      transition: {
        title: "Restoring snapshot",
        detail: "Checkpointing the outgoing timeline, then loading the selected snapshot and restarting the runtime.",
      },
      work: () => api.restore(timeline.id, dialog.snapshotId),
      reloadPreview: true,
      after: () => {
        state.selectedId = timeline.id;
        state.view = "workspace";
        state.panToId = timeline.id;
      },
      success: () => `Restored snapshot ${shortId(dialog.snapshotId)} on “${timeline.name}”. The outgoing state was checkpointed first.`,
    });
  }
}

async function createSnapshot(id) {
  const timeline = byId(id);
  if (!canCheckpoint(timeline)) {
    toast("info", timeline && !timeline.is_active
      ? "Enter this timeline before saving a snapshot. Only the live runtime can be checkpointed."
      : "This timeline cannot be checkpointed.");
    return;
  }
  await runMutation({
    transition: {
      title: "Saving snapshot",
      detail: "Checkpointing the live code and database. The runtime will restart.",
    },
    work: () => api.createSnapshot(timeline.id),
    reloadPreview: true,
    success: (snapshot) => `Saved snapshot ${shortId(snapshot?.id)} for “${timeline.name}”.`,
  });
}

function ensureCompareDefaults() {
  if (state.timelines.length < 2) return;
  const ids = new Set(state.timelines.map((timeline) => timeline.id));
  if (!ids.has(state.compare.leftId)) state.compare.leftId = state.activeTimelineId || state.timelines[0].id;
  if (!ids.has(state.compare.rightId) || state.compare.rightId === state.compare.leftId) {
    const other = state.timelines.find((timeline) => timeline.id !== state.compare.leftId);
    state.compare.rightId = other ? other.id : "";
  }
}

function orderingText(value) {
  if (value === "chronological") return "Chronological";
  if (value === "popular") return "Popularity";
  if (!value) return "Not reported";
  return String(value);
}

function button({ action, id, snapshotId, label, variant = "ghost", disabled = false, title = "", wide = false, iconName = "", ariaDisabled = false }) {
  const classes = ["btn", variant === "primary" ? "btn-primary" : "", variant === "danger" ? "btn-danger" : "", variant === "quiet" ? "btn-quiet" : "", wide ? "wide" : ""]
    .filter(Boolean)
    .join(" ");
  return `<button type="button" class="${classes}" data-action="${action}" ${id ? `data-id="${esc(id)}"` : ""} ${snapshotId ? `data-snapshot-id="${esc(snapshotId)}"` : ""} ${disabled ? "disabled" : ""} ${ariaDisabled ? 'aria-disabled="true"' : ""} ${title ? `title="${esc(title)}"` : ""}>${iconName ? icon(iconName) : ""}${esc(label)}</button>`;
}

function statusPill(timeline) {
  const root = !timeline.parent_id;
  const kind = root ? "root" : timeline.status;
  const label = root ? `Root · ${timeline.status}` : statusLabel(timeline);
  return `<span class="status-pill ${esc(kind)}">${esc(label)}</span>`;
}

function renderTopbar() {
  const health = state.health;
  const online = state.connected && health;
  const runtimeOn = Boolean(health && health.runtime_running);
  const engineClass = !online ? "bad" : health.status === "ok" && runtimeOn ? "ok" : "warn";
  const engineText = !online ? "Engine offline" : health.status === "ok" ? "Engine connected" : "Engine degraded";
  const active = activeTimeline();
  document.getElementById("topbar").innerHTML = `
    <div class="brand">
      <span class="mark">${icon("logo")}</span>
      <span class="word">PARADOX</span>
    </div>
    <div class="project-chip">
      <span class="project-kicker">Project</span>
      <strong>Sample Feed</strong>
    </div>
    <div class="top-status">
      <button type="button" class="pill-button" data-action="retry" title="Check the engine connection">
        <span class="dot ${engineClass}"></span>${esc(engineText)}
      </button>
      <button type="button" class="pill-button keep" data-action="show-active" title="Show the live timeline">
        <span class="dot live"></span><span>Live</span><strong>${esc(active ? active.name : "None")}</strong>
      </button>
      <span class="pill">
        <span class="dot ${runtimeOn ? "ok" : "warn"}"></span>${runtimeOn ? "Runtime running" : "Runtime stopped"}
      </span>
    </div>
    <div class="top-actions">
      <div class="hints"><kbd>C</kbd> Future <kbd>E</kbd> Enter <kbd>F</kbd> Fit</div>
      <button type="button" class="icon-btn" data-action="refresh" title="Refresh timelines and preview" aria-label="Refresh">${icon("refresh")}</button>
      <button type="button" class="btn btn-primary" data-action="open-composer">${icon("plus")}Create future</button>
      <button type="button" class="btn details-toggle" data-action="toggle-details" aria-expanded="${state.detailsOpen ? "true" : "false"}">Details</button>
    </div>
    <div class="busy-bar" aria-hidden="true"></div>
  `;
}

function renderSidebar() {
  const items = NAV.map((item) => `
      <button type="button" class="nav-btn ${state.view === item.id ? "is-active" : ""}" data-action="set-view" data-view="${item.id}" ${state.view === item.id ? 'aria-current="page"' : ""} title="${esc(item.label)}">
      <span class="nav-ico">${icon(item.icon)}</span>
      <span class="nav-label">${esc(item.label)}</span>
      <kbd class="nav-kbd">${item.key}</kbd>
    </button>
  `).join("");
  const count = state.timelines.length;
  document.getElementById("sidebar").innerHTML = `
    <div class="side-section">Navigate</div>
    ${items}
    <div class="side-footer"><span>${count} timeline${count === 1 ? "" : "s"}</span></div>
  `;
}

function renderCrumbs() {
  const selected = selectedTimeline();
  if (!selected) return '<span class="muted">Select a timeline</span>';
  const chain = ancestry(selected.id);
  return chain.map((timeline, index) => {
    if (index === chain.length - 1) return `<span class="crumb-current">${esc(timeline.name)}</span>`;
    return `<button type="button" class="crumb" data-action="select-crumb" data-id="${esc(timeline.id)}">${esc(timeline.name)}</button><span class="muted">/</span>`;
  }).join("");
}

function renderGraphToolbar() {
  const toolbar = document.getElementById("graph-toolbar");
  if (!toolbar) return;
  const selected = selectedTimeline();
  const parentBlocked = parentReturnReason(selected);
  toolbar.innerHTML = `
    <div class="toolbar-card">
      <div class="toolbar-title">
        <div>
          <h1>Timeline graph</h1>
          <p>Selection inspects a future. Enter switches the live runtime.</p>
        </div>
      </div>
      <div class="crumbs" aria-label="Timeline ancestry">${renderCrumbs()}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${button({
          action: "return-parent",
          label: "Return to parent",
          iconName: "back",
          disabled: Boolean(parentBlocked) && !(selected && byId(selected.parent_id) && byId(selected.parent_id).is_active),
          title: parentBlocked || "Enter the parent timeline.",
        })}
        ${button({
          action: "open-composer",
          id: selected && canSproutFrom(selected) ? selected.id : "",
          label: "Create child",
          iconName: "plus",
          disabled: !canSproutFrom(selected),
          title: canSproutFrom(selected) ? "Sprout a child from the selected timeline." : "Declined timelines cannot be parents.",
        })}
      </div>
    </div>
    <div class="toolbar-card zoom-cluster">
      <button type="button" class="icon-btn" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">${icon("zoomOut")}</button>
      <span class="zoom-label" id="zoom-label">${Math.round(state.graph.zoom * 100)}%</span>
      <button type="button" class="icon-btn" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">${icon("zoomIn")}</button>
      <button type="button" class="icon-btn" data-action="zoom-fit" aria-label="Fit graph" title="Fit to view">${icon("fit")}</button>
    </div>
  `;
}

function svgEl(name, attrs, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value != null) node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function glyph(kind, parent) {
  const group = svgEl("g", { transform: "translate(16 18)" }, parent);
  if (kind === "root") {
    svgEl("polygon", { points: "8,0 16,8 8,16 0,8", fill: "none", stroke: "#b7c0ff", "stroke-width": "1.6" }, group);
  } else if (kind === "pending") {
    svgEl("circle", { cx: "8", cy: "8", r: "6.5", fill: "none", stroke: "#e2c481", "stroke-width": "1.6", "stroke-dasharray": "2.5 2.2" }, group);
  } else if (kind === "confirmed") {
    svgEl("circle", { cx: "8", cy: "8", r: "6.5", fill: "none", stroke: "#8ed0aa", "stroke-width": "1.6" }, group);
    svgEl("path", { d: "M4.5 8.2 7 10.7 11.6 5.6", fill: "none", stroke: "#8ed0aa", "stroke-width": "1.6", "stroke-linecap": "round" }, group);
  } else {
    svgEl("rect", { x: "2", y: "2", width: "12", height: "12", rx: "2", fill: "none", stroke: "#aaa6b6", "stroke-width": "1.5", "stroke-dasharray": "2.4 2" }, group);
    svgEl("path", { d: "M4 12 12 4", stroke: "#aaa6b6", "stroke-width": "1.4" }, group);
  }
  return group;
}

function renderGraph() {
  const board = document.getElementById("graph-board");
  if (!board) return;
  if (!state.timelines.length) {
    board.innerHTML = "";
    return;
  }
  state.layout = layoutTimelines(state.timelines);
  const signature = state.timelines.map((timeline) => [timeline.id, timeline.name, timeline.status, timeline.parent_id, timeline.modification, timeline.is_active].join(":")).join("|");
  const selectionKey = `${state.selectedId || ""}:${state.activeTimelineId || ""}`;
  if (board.dataset.signature === signature) {
    syncGraphSelection();
    board.dataset.selection = selectionKey;
    return;
  }
  const firstPaint = state.seenNodeIds.size === 0;
  board.dataset.signature = signature;
  board.dataset.selection = selectionKey;
  board.innerHTML = "";

  const svg = svgEl("svg", { role: "tree", "aria-label": "Timeline graph" }, board);
  const defs = svgEl("defs", {}, svg);
  const pattern = svgEl("pattern", { id: "dots", width: "22", height: "22", patternUnits: "userSpaceOnUse" }, defs);
  svgEl("circle", { cx: "1", cy: "1", r: "1", fill: "rgba(255,255,255,0.045)" }, pattern);
  const camera = svgEl("g", { id: "graph-camera" }, svg);
  svgEl("rect", { x: "-4000", y: "-4000", width: "8000", height: "8000", fill: "url(#dots)" }, camera);
  const edges = svgEl("g", {}, camera);
  const nodes = svgEl("g", {}, camera);

  const activeChain = new Set(ancestry(state.activeTimelineId).map((timeline) => timeline.id));
  const selectedChain = new Set(ancestry(state.selectedId).map((timeline) => timeline.id));

  for (const [parentId, kids] of state.layout.children) {
    const parentPos = state.layout.positions.get(parentId);
    if (!parentPos) continue;
    for (const child of kids) {
      const childPos = state.layout.positions.get(child.id);
      if (!childPos) continue;
      const x1 = parentPos.x + NODE_W;
      const y1 = parentPos.y + NODE_H / 2;
      const x2 = childPos.x;
      const y2 = childPos.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      const path = svgEl("path", {
        d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
        class: "edge",
        "data-child": child.id,
      }, edges);
      if (child.status === "declined") path.classList.add("is-declined");
      if (selectedChain.has(child.id) && selectedChain.has(parentId)) path.classList.add("is-selected");
      if (activeChain.has(child.id) && activeChain.has(parentId)) path.classList.add("is-live");
      svgEl("circle", {
        cx: x2,
        cy: y2,
        r: "2.6",
        class: `edge-cap${activeChain.has(child.id) ? " is-live" : ""}`,
      }, edges);
    }
  }

  for (const timeline of state.timelines) {
    const pos = state.layout.positions.get(timeline.id);
    if (!pos) continue;
    const group = svgEl("g", {
      class: "node",
      tabindex: "0",
      role: "treeitem",
      "data-id": timeline.id,
      "aria-selected": timeline.id === state.selectedId ? "true" : "false",
      "aria-label": `${timeline.name}, ${statusLabel(timeline)}, ${modificationShort(timeline.modification)}${timeline.is_active ? ", live" : ""}`,
      transform: `translate(${pos.x} ${pos.y})`,
    }, nodes);
    if (timeline.id === state.selectedId) group.classList.add("is-selected");
    if (timeline.is_active) group.classList.add("is-active");
    if (timeline.status === "declined") group.classList.add("is-declined");
    if (!firstPaint && !state.seenNodeIds.has(timeline.id)) group.classList.add("is-new");

    const rootNode = !timeline.parent_id;
    const radius = rootNode ? 7 : timeline.status === "pending" ? 18 : timeline.status === "declined" ? 5 : 12;
    if (timeline.is_active) {
      svgEl("rect", {
        x: -8,
        y: -8,
        width: NODE_W + 16,
        height: NODE_H + 16,
        rx: radius + 6,
        fill: "rgba(125,106,246,0.1)",
        stroke: "rgba(195,182,255,0.28)",
        "stroke-width": "10",
      }, group);
    }
    const card = svgEl("rect", {
      class: "node-card",
      width: NODE_W,
      height: NODE_H,
      rx: radius,
      fill: "#111119",
      stroke: "rgba(255,255,255,0.1)",
      "stroke-width": "1.25",
    }, group);
    if (timeline.status === "pending" || timeline.status === "declined") card.setAttribute("stroke-dasharray", "5 4");

    const brackets = svgEl("g", { class: "brackets" }, group);
    const corners = [[-5, -5, 1, 1], [NODE_W + 5, -5, -1, 1], [-5, NODE_H + 5, 1, -1], [NODE_W + 5, NODE_H + 5, -1, -1]];
    for (const [x, y, sx, sy] of corners) {
      svgEl("path", { d: `M ${x + sx * 10} ${y} H ${x} V ${y + sy * 10}`, fill: "none", stroke: "#f4f1ff", "stroke-width": "1.4" }, brackets);
    }

    glyph(rootNode ? "root" : timeline.status === "confirmed" ? "confirmed" : timeline.status === "declined" ? "declined" : "pending", group);
    svgEl("text", { class: "node-name", x: "42", y: "34" }, group).textContent = truncate(timeline.name, timeline.is_active ? 16 : 22);
    svgEl("text", { class: "node-meta", x: "42", y: "54" }, group).textContent = rootNode ? `ROOT · ${String(timeline.status || "").toUpperCase()}` : statusLabel(timeline).toUpperCase();
    svgEl("text", { class: "node-mod", x: "16", y: "76" }, group).textContent = modificationShort(timeline.modification);
    if (timeline.is_active) {
      svgEl("rect", { x: NODE_W - 52, y: "14", width: "38", height: "16", rx: "8", fill: "#c3b6ff" }, group);
      svgEl("text", { class: "live-badge", x: NODE_W - 33, y: "22", "text-anchor": "middle", "dominant-baseline": "central" }, group).textContent = "LIVE";
    }
    const title = svgEl("title", {}, group);
    title.textContent = `${timeline.name} · ${statusLabel(timeline)} · ${modificationLabel(timeline.modification)}`;
  }

  state.seenNodeIds = new Set(state.timelines.map((timeline) => timeline.id));
  applyCamera();
  observeBoard();
}

function syncGraphSelection() {
  const activeChain = new Set(ancestry(state.activeTimelineId).map((timeline) => timeline.id));
  const selectedChain = new Set(ancestry(state.selectedId).map((timeline) => timeline.id));
  document.querySelectorAll(".node").forEach((node) => {
    const id = node.dataset.id;
    const timeline = byId(id);
    node.classList.toggle("is-selected", id === state.selectedId);
    node.classList.toggle("is-active", Boolean(timeline && timeline.is_active));
    node.setAttribute("aria-selected", id === state.selectedId ? "true" : "false");
  });
  document.querySelectorAll(".edge").forEach((edge) => {
    const child = byId(edge.dataset.child);
    if (!child) return;
    edge.classList.toggle("is-declined", child.status === "declined");
    edge.classList.toggle("is-selected", selectedChain.has(child.id) && selectedChain.has(child.parent_id));
    edge.classList.toggle("is-live", activeChain.has(child.id) && activeChain.has(child.parent_id));
  });
}

function applyCamera() {
  const camera = document.getElementById("graph-camera");
  if (!camera) return;
  camera.setAttribute("transform", `translate(${state.graph.panX} ${state.graph.panY}) scale(${state.graph.zoom})`);
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = `${Math.round(state.graph.zoom * 100)}%`;
}

function fitGraph({ animate = false } = {}) {
  const board = document.getElementById("graph-board");
  if (!board || !state.layout) return false;
  const rect = board.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return false;
  const { minX, minY, maxX, maxY } = state.layout.bounds;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const toolbar = document.querySelector(".graph-toolbar");
  const topInset = Math.min(168, (toolbar ? toolbar.getBoundingClientRect().height : 96) + 28);
  const padX = 64;
  const bottomInset = 64;
  const availW = Math.max(rect.width - padX * 2, 80);
  const availH = Math.max(rect.height - topInset - bottomInset, 80);
  const zoom = clamp(Math.min(availW / width, availH / height), 0.35, 1.15);
  const next = {
    zoom,
    panX: (rect.width - width * zoom) / 2 - minX * zoom,
    panY: topInset + (availH - height * zoom) / 2 - minY * zoom,
  };
  moveCamera(next, animate);
  state.didFitOnce = true;
  return true;
}

function centerNode(id, { animate = false } = {}) {
  const board = document.getElementById("graph-board");
  const pos = state.layout && state.layout.positions.get(id);
  if (!board || !pos) return;
  const rect = board.getBoundingClientRect();
  const zoom = state.graph.zoom;
  moveCamera({
    zoom,
    panX: rect.width / 2 - (pos.x + NODE_W / 2) * zoom,
    panY: rect.height / 2 - (pos.y + NODE_H / 2) * zoom,
  }, animate);
  state.graph.userAdjusted = true;
}

let cameraFrame = 0;

function moveCamera(next, animate) {
  window.cancelAnimationFrame(cameraFrame);
  if (!animate || reducedMotion()) {
    Object.assign(state.graph, next);
    applyCamera();
    return;
  }
  const start = { panX: state.graph.panX, panY: state.graph.panY, zoom: state.graph.zoom };
  const began = performance.now();
  const step = (now) => {
    const t = clamp((now - began) / 260, 0, 1);
    const eased = 1 - (1 - t) ** 3;
    state.graph.panX = start.panX + (next.panX - start.panX) * eased;
    state.graph.panY = start.panY + (next.panY - start.panY) * eased;
    state.graph.zoom = start.zoom + (next.zoom - start.zoom) * eased;
    applyCamera();
    if (t < 1) cameraFrame = requestAnimationFrame(step);
  };
  cameraFrame = requestAnimationFrame(step);
}

function zoomAt(x, y, factor) {
  const nextZoom = clamp(state.graph.zoom * factor, 0.35, 1.75);
  const ratio = nextZoom / state.graph.zoom;
  state.graph.panX = x - (x - state.graph.panX) * ratio;
  state.graph.panY = y - (y - state.graph.panY) * ratio;
  state.graph.zoom = nextZoom;
  state.graph.userAdjusted = true;
  applyCamera();
}

function zoomBy(factor) {
  const board = document.getElementById("graph-board");
  if (!board) return;
  const rect = board.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
}

function observeBoard() {
  const board = document.getElementById("graph-board");
  if (!board || board.dataset.observed) return;
  board.dataset.observed = "true";
  resizeObserver.observe(board);
}

function workspaceHTML() {
  return `
    <div class="graph-view">
      <div class="graph-toolbar" id="graph-toolbar"></div>
      <div class="graph-board" id="graph-board" tabindex="0" aria-label="Timeline canvas"></div>
      <div class="legend" aria-hidden="true">
        <span><i class="swatch root"></i>Root</span>
        <span><i class="swatch pending"></i>Pending</span>
        <span><i class="swatch confirmed"></i>Confirmed</span>
        <span><i class="swatch declined"></i>Declined</span>
        <span><i class="swatch live"></i>Live</span>
        <span><i class="swatch selected"></i>Selected</span>
      </div>
      <div class="board-message" id="board-message" hidden></div>
    </div>
  `;
}

function boardMessage() {
  const slot = document.getElementById("board-message");
  if (!slot) return;
  if (state.loadingTimelines) {
    slot.hidden = false;
    slot.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto 10px"></div>Loading timelines…</div>';
    return;
  }
  if (!state.timelines.length) {
    slot.hidden = false;
    slot.innerHTML = `
      <div class="empty">
        <p>${esc(state.listError || "No timelines yet.")}</p>
        <button type="button" class="btn" data-action="retry">Retry connection</button>
      </div>`;
    return;
  }
  slot.hidden = true;
  slot.innerHTML = "";
}

function timelineRows() {
  if (!state.timelines.length) {
    return `<div class="empty">${esc(state.listError || "No timelines yet.")}</div>`;
  }
  return `<div class="timeline-list">${state.timelines.map((timeline) => {
    const parent = timeline.parent_id ? byId(timeline.parent_id) : null;
    return `
      <article class="timeline-row ${timeline.id === state.selectedId ? "is-selected" : ""}">
        <button type="button" class="btn btn-quiet" style="height:auto;padding:0;justify-content:flex-start" data-action="focus-timeline" data-id="${esc(timeline.id)}">
          <span class="row-title">
            <strong>${esc(timeline.name)}</strong>
            <span class="muted mono">${esc(shortId(timeline.id))}</span>
          </span>
        </button>
        <span class="hide-narrow">${statusPill(timeline)}</span>
        <span class="hide-narrow muted">${esc(modificationLabel(timeline.modification))}${parent ? ` · from ${esc(parent.name)}` : ""}</span>
        <span class="hide-narrow">${timeline.is_active ? '<span class="status-pill root">Live</span>' : ""}</span>
        <span class="row-actions">
          ${button({ action: "enter-timeline", id: timeline.id, label: timeline.is_active ? "Live" : "Enter", variant: timeline.is_active ? "quiet" : "primary", disabled: !canEnter(timeline), title: enterReason(timeline) })}
        </span>
      </article>`;
  }).join("")}</div>`;
}

function compareHTML() {
  ensureCompareDefaults();
  if (state.timelines.length < 2) {
    return `<div class="view-scroll"><div class="view-head"><div><h1>Compare</h1><p>Sprout another future to compare two real timelines. Paradox will not invent measurements.</p></div></div></div>`;
  }
  ensureSnapshot(state.compare.leftId);
  ensureSnapshot(state.compare.rightId);
  const options = state.timelines.map((timeline) => `<option value="${esc(timeline.id)}">${esc(timeline.name)}</option>`).join("");
  const left = byId(state.compare.leftId);
  const right = byId(state.compare.rightId);
  const rows = [
    ["Name", left?.name, right?.name],
    ["Status", left ? `${left.status}${left.parent_id ? "" : " · root"}` : "—", right ? `${right.status}${right.parent_id ? "" : " · root"}` : "—"],
    ["Parent", parentName(left), parentName(right)],
    ["Modification", left ? modificationLabel(left.modification) : "—", right ? modificationLabel(right.modification) : "—"],
    ["Created", left ? formatFull(left.created_at) : "—", right ? formatFull(right.created_at) : "—"],
    ["Live runtime", left?.is_active ? "Active" : "Inactive", right?.is_active ? "Active" : "Inactive"],
    ["Snapshots", snapshotCount(left), snapshotCount(right)],
  ];
  return `
    <div class="view-scroll">
      <div class="view-head">
        <div>
          <h1>Compare</h1>
          <p>Metadata comes from the engine. Measured outcomes stay empty until a later milestone reports them.</p>
        </div>
      </div>
      ${state.compare.leftId === state.compare.rightId ? '<div class="banner">Choose two different timelines.</div>' : ""}
      <table class="compare-table">
        <thead>
          <tr>
            <th>Field</th>
            <th><label class="sr-only" for="compare-left">Left timeline</label><select id="compare-left" class="compare-select">${options.replace(`value="${esc(state.compare.leftId)}"`, `value="${esc(state.compare.leftId)}" selected`)}</select></th>
            <th><label class="sr-only" for="compare-right">Right timeline</label><select id="compare-right" class="compare-select">${options.replace(`value="${esc(state.compare.rightId)}"`, `value="${esc(state.compare.rightId)}" selected`)}</select></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(([label, a, b]) => `<tr class="${a !== b ? "is-diff" : ""}"><th>${esc(label)}</th><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}
        </tbody>
      </table>
      <section class="future-block">
        <h2>Measured outcomes</h2>
        <p class="muted">Not yet available. The engine does not report tests, latency, security findings, or memory. Those results can be added here when the backend provides them. Promotion remains unavailable and is not simulated.</p>
      </section>
    </div>
  `;
}

function parentName(timeline) {
  if (!timeline) return "—";
  if (!timeline.parent_id) return "None (root)";
  const parent = byId(timeline.parent_id);
  return parent ? parent.name : "Missing parent";
}

function snapshotCount(timeline) {
  if (!timeline) return "—";
  const status = state.snapshotStatus[timeline.id];
  if (status === "ready") return String((state.snapshotsById[timeline.id] || []).length);
  if (status === "error") return "Unavailable";
  return "Loading…";
}

function activityHTML() {
  const items = state.activity.length
    ? state.activity.map((item) => `
        <article class="activity-item">
          <span class="dot ${item.level === "error" ? "bad" : item.level === "success" ? "ok" : "live"}"></span>
          <p>${esc(item.message)}</p>
          <time datetime="${esc(item.at)}">${esc(formatTime(item.at))}</time>
        </article>
      `).join("")
    : '<div class="empty">No activity yet. Create a future or enter a timeline, and this log will record what the engine actually did.</div>';
  return `
    <div class="view-scroll">
      <div class="view-head"><div><h1>Activity</h1><p>Session log for engine calls made from this workspace. It is not a fabricated history.</p></div></div>
      <div class="activity-list">${items}</div>
    </div>
  `;
}

function settingsHTML() {
  const health = state.health;
  return `
    <div class="view-scroll">
      <div class="view-head"><div><h1>Settings</h1><p>Connection details for this local milestone. There is no account or project switcher yet.</p></div></div>
      <div class="setting-grid">
        <section class="setting-card">
          <h2>Engine</h2>
          <p>Requests go to the timeline engine. Status is read from <span class="mono">/api/health</span>.</p>
          <div class="kv">
            <div class="kv-row"><span>Base URL</span><strong class="mono">${esc(API_BASE)}</strong></div>
            <div class="kv-row"><span>Status</span><strong>${esc(health ? health.status : "offline")}</strong></div>
            <div class="kv-row"><span>Runtime</span><strong>${health && health.runtime_running ? "Running" : "Stopped"}</strong></div>
            <div class="kv-row"><span>Active id</span><strong class="mono">${esc(health ? health.active_timeline_id : "—")}</strong></div>
          </div>
          ${state.healthError ? `<div class="banner">${esc(state.healthError)}</div>` : ""}
          <button type="button" class="btn" data-action="retry">Reconnect</button>
        </section>
        <section class="setting-card">
          <h2>Live application</h2>
          <p>The preview uses the absolute app URL from the timeline list. The runtime port is not hardcoded.</p>
          <p class="mono">${esc(state.appUrl || "Waiting for the engine…")}</p>
          <button type="button" class="btn" data-action="preview-reload">Reload preview</button>
        </section>
        <section class="setting-card">
          <h2>Keyboard</h2>
          <ul class="shortcut-list">
            <li><span>Create future</span><kbd>C</kbd></li>
            <li><span>Enter selected future</span><kbd>E</kbd></li>
            <li><span>Fit graph</span><kbd>F</kbd></li>
            <li><span>Zoom</span><span><kbd>-</kbd> <kbd>=</kbd></span></li>
            <li><span>Move selection</span><span>Arrow keys</span></li>
            <li><span>Views</span><span><kbd>1</kbd> to <kbd>5</kbd></span></li>
            <li><span>Close overlay</span><kbd>Esc</kbd></li>
            <li><span>Expand preview</span><kbd>P</kbd></li>
          </ul>
        </section>
        <section class="setting-card">
          <h2>Later milestones</h2>
          <p>Arbitrary AI edits, measured evaluation, and promotion are visible in the product but not implemented. Paradox will not pretend those actions succeeded.</p>
        </section>
      </div>
    </div>
  `;
}

function renderStage() {
  const stage = document.getElementById("stage");
  if (state.view === "workspace") {
    if (stage.dataset.view !== "workspace") {
      stage.dataset.view = "workspace";
      stage.innerHTML = workspaceHTML();
    }
    renderGraphToolbar();
    boardMessage();
    renderGraph();
    return;
  }
  stage.dataset.view = state.view;
  if (state.view === "timelines") stage.innerHTML = `<div class="view-scroll"><div class="view-head"><div><h1>Timelines</h1><p>Every future the engine still stores, including declined ones. Entering a row switches the runtime.</p></div>${button({ action: "open-composer", label: "Create future", variant: "primary", iconName: "plus" })}</div>${state.listError ? `<div class="banner"><span>${esc(state.listError)}</span><button type="button" class="btn" data-action="retry">Retry</button></div>` : ""}${timelineRows()}</div>`;
  if (state.view === "compare") stage.innerHTML = compareHTML();
  if (state.view === "activity") stage.innerHTML = activityHTML();
  if (state.view === "settings") stage.innerHTML = settingsHTML();
}

function section(id, title, body) {
  const collapsed = Boolean(state.collapsed[id]);
  return `
    <section class="section ${collapsed ? "is-collapsed" : ""}">
      <button type="button" class="section-toggle" data-action="toggle-section" data-section="${id}" aria-expanded="${collapsed ? "false" : "true"}">
        ${esc(title)}
        <span class="chevron">▾</span>
      </button>
      <div class="section-body">${body}</div>
    </section>
  `;
}

function snapshotSection(timeline) {
  const status = state.snapshotStatus[timeline.id];
  const snapshots = state.snapshotsById[timeline.id] || [];
  let body = '<p class="field-help">Oldest first. Restoring checkpoints the outgoing timeline, then restarts the live app.</p>';
  if (status === "error") {
    body += `<div class="callout">${esc(state.snapshotError[timeline.id] || "Snapshots could not be loaded.")}</div>`;
  } else if (status !== "ready") {
    body += '<div class="callout">Loading snapshots…</div>';
  } else if (!snapshots.length) {
    body += '<div class="callout">No snapshots recorded for this timeline.</div>';
  } else {
    body += `<div class="snapshot-list">${snapshots.map((snapshot, index) => `
      <article class="snapshot-item">
        <div>
          <strong>${String(index + 1).padStart(2, "0")} · ${esc(formatTime(snapshot.created_at))}</strong>
          <p class="muted mono">${esc(snapshot.id)}${snapshot.id === timeline.snapshot_id ? " · head" : ""}</p>
        </div>
        ${button({
          action: "ask-restore",
          id: timeline.id,
          snapshotId: snapshot.id,
          label: "Restore",
          disabled: !canRestore(timeline) || state.busy,
          title: canRestore(timeline) ? "Checkpoint the outgoing state, then restore this snapshot." : "Declined timelines cannot be restored.",
        })}
      </article>
    `).join("")}</div>`;
  }
  body += button({
    action: "create-snapshot",
    id: timeline.id,
    label: "Save snapshot",
    wide: true,
    disabled: !canCheckpoint(timeline) || state.busy,
    title: canCheckpoint(timeline) ? "Checkpoint the live code and database." : "Only the active timeline can be checkpointed.",
  });
  return body;
}

function renderInspector() {
  const root = document.getElementById("inspector");
  const previousScroll = root.querySelector(".inspector-scroll")?.scrollTop || 0;
  const timeline = selectedTimeline();
  if (!timeline) {
    root.innerHTML = '<div class="inspector-scroll"><div class="empty">Select a timeline in the graph. Selecting does not switch the live app.</div></div>';
    return;
  }
  const parent = timeline.parent_id ? byId(timeline.parent_id) : null;
  const kids = childrenOf(timeline.id);
  const modification = timeline.modification;
  const modCopy = modification === "popular_feed"
    ? MODIFICATIONS.popular_feed.detail
    : modification === "none"
      ? MODIFICATIONS.none.detail
      : "No sprout modification was recorded. This is the original timeline.";
  const ordering = state.ordering.timelineId === state.activeTimelineId ? state.ordering : null;
  const runtimeCopy = timeline.is_active
    ? `This timeline is serving the preview.${ordering && ordering.value ? ` The live app reports ${orderingText(ordering.value).toLowerCase()} ordering.` : ""}`
    : "The preview is serving a different future. Enter this timeline to run it.";
  const decision = decideReason(timeline);
  const entering = enterReason(timeline);
  root.innerHTML = `
    <div class="inspector-scroll">
      <div class="identity">
        <p class="kicker">${timeline.is_active ? "Live timeline" : "Selected timeline"}</p>
        <h2>${esc(timeline.name)}</h2>
        <div class="identity-meta">
          ${statusPill(timeline)}
          ${timeline.is_active ? '<span class="status-pill root">Live</span>' : '<span class="status-pill">Not live</span>'}
        </div>
      </div>
      <div class="action-grid">
        ${button({ action: "enter-timeline", id: timeline.id, label: timeline.is_active ? "Already live" : "Enter future", variant: "primary", wide: true, disabled: !canEnter(timeline), title: entering, iconName: "enter" })}
        ${button({ action: "return-parent", label: "Return to parent", iconName: "back", disabled: Boolean(parentReturnReason(timeline)) && !(parent && parent.is_active), title: parentReturnReason(timeline) || "Enter the parent timeline." })}
        ${button({ action: "open-composer", id: timeline.id, label: "Create child", iconName: "plus", disabled: !canSproutFrom(timeline), title: canSproutFrom(timeline) ? "Sprout from this timeline." : "Declined timelines cannot be parents." })}
        ${button({ action: "confirm-timeline", id: timeline.id, label: "Confirm", disabled: !canDecide(timeline), title: decision || "Accept this future without merging it." })}
        ${button({ action: "ask-decline", id: timeline.id, label: "Decline", variant: "danger", disabled: !canDecide(timeline), title: decision || "Archive this future without deleting it." })}
        ${button({ action: "promote-unavailable", label: "Promote", wide: true, ariaDisabled: true, title: "Promotion is not available in this milestone." })}
      </div>
      ${section("overview", "Overview", `
        <div class="kv">
          <div class="kv-row"><span>Name</span><strong>${esc(timeline.name)}</strong></div>
          <div class="kv-row"><span>Status</span><strong>${esc(timeline.status)}</strong></div>
          <div class="kv-row"><span>Parent</span><strong>${esc(parent ? parent.name : timeline.parent_id ? "Missing parent" : "None (root)")}</strong></div>
          <div class="kv-row"><span>Created</span><strong>${esc(formatFull(timeline.created_at))}<br><span class="muted">${esc(formatRelative(timeline.created_at))}</span></strong></div>
          <div class="kv-row"><span>Active</span><strong>${timeline.is_active ? "Yes, serving the runtime" : "No"}</strong></div>
          <div class="kv-row"><span>Id</span><strong class="mono">${esc(timeline.id)}</strong></div>
        </div>
        <button type="button" class="btn btn-quiet" data-action="copy-id" data-id="${esc(timeline.id)}">${icon("copy")}Copy id</button>
        <div class="callout">${kids.length ? `${kids.length} child timeline${kids.length === 1 ? "" : "s"}. Descendants stay independent if this future is declined.` : "No child timelines yet."}</div>
      `)}
      ${section("modification", "Code modification", `
        <div class="kv">
          <div class="kv-row"><span>Recorded</span><strong class="mono">${esc(modification == null ? "null" : modification)}</strong></div>
          <div class="kv-row"><span>Meaning</span><strong>${esc(modificationLabel(modification))}</strong></div>
        </div>
        <div class="callout">${esc(modCopy)} Provenance describes the sprout operation, not necessarily a later restored snapshot.</div>
      `)}
      ${section("snapshots", "Snapshots", snapshotSection(timeline))}
      ${section("runtime", "Runtime", `
        <div class="callout"><strong>${timeline.is_active ? "Serving preview" : "Inactive"}</strong><br>${esc(runtimeCopy)}</div>
        <div class="kv">
          <div class="kv-row"><span>Engine</span><strong>${state.health ? esc(state.health.status) : "Offline"}</strong></div>
          <div class="kv-row"><span>Process</span><strong>${state.health && state.health.runtime_running ? "Running" : "Stopped"}</strong></div>
          <div class="kv-row"><span>App URL</span><strong class="mono">${esc(state.appUrl || "—")}</strong></div>
          ${timeline.is_active ? `<div class="kv-row"><span>Ordering</span><strong>${esc(ordering && ordering.value ? orderingText(ordering.value) : ordering && ordering.error ? "Unavailable" : "Checking…")}</strong></div>` : ""}
        </div>
      `)}
      ${section("evaluation", "Evaluation", `
        <div class="callout"><strong>Not yet available.</strong><br>The engine does not provide test counts, security scores, latency, memory, or code-change statistics. This section will show measured outcomes when that API exists.</div>
      `)}
    </div>
  `;
  const scroller = root.querySelector(".inspector-scroll");
  if (scroller) scroller.scrollTop = previousScroll;
}

function ensurePreview() {
  const root = document.getElementById("preview");
  if (root.querySelector("#app-frame")) return;
  root.innerHTML = `
    <div class="preview-chrome">
      <div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="url" id="preview-url"></div>
      <div class="ordering-chip" id="preview-ordering"></div>
      <div class="preview-actions">
        <button type="button" class="icon-btn" data-action="preview-reload" aria-label="Reload preview" title="Reload preview">${icon("refresh")}</button>
        <button type="button" class="icon-btn" id="preview-expand" data-action="preview-expand" aria-label="Expand preview" title="Expand preview">${icon("expand")}</button>
      </div>
    </div>
    <div class="preview-frame">
      <iframe id="app-frame" title="Live Sample Feed application" referrerpolicy="no-referrer"></iframe>
      <div class="veil" id="preview-veil"></div>
    </div>
  `;
  const frame = document.getElementById("app-frame");
  frame.addEventListener("load", onFrameLoad);
  frame.addEventListener("error", () => {
    state.preview.loading = false;
    state.preview.error = true;
    updatePreviewVeil();
  });
}

function updatePreviewVeil() {
  const veil = document.getElementById("preview-veil");
  if (!veil) return;
  if (state.preview.loading) {
    veil.className = "veil is-visible";
    veil.innerHTML = `<div class="spinner"></div><div>${state.transition ? "Restarting the runtime…" : "Opening the live application…"}</div>`;
    return;
  }
  if (state.preview.error) {
    veil.className = "veil is-visible";
    veil.innerHTML = `<div>The live app did not load.</div><button type="button" class="btn" data-action="preview-reload">Try again</button>`;
    return;
  }
  veil.className = "veil";
  veil.innerHTML = "";
}

function renderPreview() {
  ensurePreview();
  const url = document.getElementById("preview-url");
  const ordering = document.getElementById("preview-ordering");
  const expand = document.getElementById("preview-expand");
  if (url) url.textContent = state.appUrl || "Waiting for app URL…";
  if (ordering) {
    const known = state.ordering.timelineId === state.activeTimelineId && state.ordering.value;
    ordering.textContent = known ? `Ordering · ${orderingText(state.ordering.value)}` : "";
  }
  if (expand) {
    expand.dataset.action = state.preview.expanded ? "preview-collapse" : "preview-expand";
    expand.setAttribute("aria-label", state.preview.expanded ? "Collapse preview" : "Expand preview");
    expand.innerHTML = icon(state.preview.expanded ? "collapse" : "expand");
  }
  syncPreviewFrame();
  updatePreviewVeil();
}

function syncPreviewFrame() {
  const frame = document.getElementById("app-frame");
  if (!frame) return;
  if (frame.dataset.generation === String(state.preview.generation)) return;
  frame.dataset.generation = String(state.preview.generation);
  if (!state.appUrl) {
    frame.src = "about:blank";
    state.preview.loading = false;
    state.preview.error = true;
    return;
  }
  state.preview.loading = true;
  state.preview.error = false;
  const generation = state.preview.generation;
  const url = state.appUrl;
  frame.src = "about:blank";
  window.setTimeout(() => {
    if (state.preview.generation !== generation) return;
    frame.src = url;
    armPreviewTimeout();
  }, 30);
}

function onFrameLoad() {
  const frame = document.getElementById("app-frame");
  if (!frame || !frame.src || frame.src.startsWith("about:")) return;
  if (frame.dataset.generation !== String(state.preview.generation)) return;
  state.preview.loading = false;
  state.preview.error = false;
  window.clearTimeout(state.preview.timer);
  updatePreviewVeil();
  refreshOrdering();
}

function renderOverlays() {
  const root = document.getElementById("overlays");
  const parts = [];
  if (isNarrow()) {
    parts.push(`<button type="button" class="inspector-backdrop" data-action="inspector-backdrop" aria-label="Close details" tabindex="-1"></button>`);
  }
  if (state.composer.open) {
    const parents = state.timelines.filter((timeline) => timeline.status !== "declined");
    const selectedMod = state.composer.modification;
    parts.push(`
      <div class="backdrop" data-action="close-composer"></div>
      <form class="modal" id="composer-form" data-trap="open" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <header>
          <div>
            <p class="kicker">New timeline</p>
            <h2 id="composer-title">Create a future</h2>
          </div>
          <button type="button" class="icon-btn" data-action="close-composer" aria-label="Close">${icon("close")}</button>
        </header>
        <p class="lede">Sprout a working child from an existing timeline. The engine checkpoints the live runtime, then activates the new future.</p>
        ${state.composer.error ? `<p class="form-error" role="alert">${esc(state.composer.error)}</p>` : ""}
        <label class="field">
          <span class="field-label">Future name <span class="muted" id="name-count">${esc(String(state.composer.name.trim().length))}/120</span></span>
          <input id="future-name" name="name" type="text" maxlength="120" required spellcheck="false" autocomplete="off" value="${esc(state.composer.name)}">
        </label>
        <label class="field">
          <span class="field-label">Parent timeline</span>
          <select id="future-parent" name="parent">
            ${parents.map((timeline) => `<option value="${esc(timeline.id)}" ${timeline.id === state.composer.parentId ? "selected" : ""}>${esc(timeline.name)} · ${esc(timeline.status)}${timeline.is_active ? " · live" : ""}</option>`).join("")}
          </select>
          <span class="field-help">Any timeline that has not been declined can be a parent. Declined timelines stay visible but cannot sprout.</span>
        </label>
        <div class="field">
          <span class="field-label">Modification</span>
          <div class="mod-grid" role="radiogroup" aria-label="Modification type">
            ${Object.entries(MODIFICATIONS).map(([key, value]) => `
              <button type="button" class="mod-card ${selectedMod === key ? "is-selected" : ""}" role="radio" aria-checked="${selectedMod === key ? "true" : "false"}" data-action="set-modification" data-modification="${key}">
                <strong>${esc(value.label)}</strong>
                <span>${esc(value.summary)}</span>
              </button>
            `).join("")}
          </div>
          <span class="field-help">${esc(MODIFICATIONS[selectedMod].detail)}</span>
        </div>
        <label class="field">
          <span class="field-label">Describe any change <span class="badge">Milestone 2</span></span>
          <textarea disabled placeholder="Arbitrary code changes are not available yet."></textarea>
          <span class="field-help">A prompt here will not create code. The engine currently accepts Popular feed and Unchanged fork only.</span>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="close-composer">Cancel</button>
          <button type="submit" class="btn btn-primary" ${state.busy ? "disabled" : ""}>Sprout future</button>
        </div>
      </form>
    `);
  }
  if (state.dialog) {
    const timeline = byId(state.dialog.timelineId);
    const name = timeline ? timeline.name : "this timeline";
    const decline = state.dialog.kind === "decline";
    parts.push(`
      <div class="backdrop dialog-backdrop" data-action="dialog-cancel"></div>
      <div class="dialog" data-trap="open" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header>
          <h2 id="dialog-title">${decline ? `Decline “${esc(name)}”?` : `Restore this snapshot of “${esc(name)}”?`}</h2>
        </header>
        <p>${decline
          ? "Decline archives this future. It stays on the graph and is not deleted. Other timelines, including its descendants, remain independently preserved. If this future is live, Paradox returns to the nearest ancestor that has not been declined."
          : "Restoration checkpoints the outgoing code and database before switching. Paradox then loads this snapshot, activates its timeline, and restarts the live app."}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" id="dialog-cancel" data-action="dialog-cancel">Cancel</button>
          <button type="button" class="btn ${decline ? "btn-danger" : "btn-primary"}" data-action="dialog-confirm">${decline ? "Decline future" : "Restore snapshot"}</button>
        </div>
      </div>
    `);
  }
  if (state.transition) {
    parts.push(`
      <div class="transition" role="status">
        <div class="transition-card">
          <div class="spinner"></div>
          <div>
            <h2>${esc(state.transition.title)}</h2>
            <p>${esc(state.transition.detail)}</p>
          </div>
        </div>
      </div>
    `);
  }
  const signature = `${state.composer.open}:${state.composer.modification}:${state.composer.error}:${state.composer.parentId}:${state.dialog ? state.dialog.kind + state.dialog.timelineId + (state.dialog.snapshotId || "") : ""}:${state.transition ? state.transition.title : ""}:${isNarrow()}:${state.detailsOpen}`;
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.innerHTML = parts.join("");
  if (state.dialog) document.getElementById("dialog-cancel")?.focus();
  else if (state.composer.open && document.activeElement && !root.contains(document.activeElement)) {
    document.getElementById("future-name")?.focus();
  }
}

function renderToasts() {
  const root = document.getElementById("toasts");
  const signature = state.toasts.map((item) => item.id).join("|");
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.innerHTML = state.toasts.map((item) => `
    <div class="toast toast-${esc(item.level)}" role="status">
      <p>${esc(item.message)}</p>
      <button type="button" class="icon-btn" data-action="dismiss-toast" data-id="${esc(item.id)}" aria-label="Dismiss notification">${icon("close")}</button>
    </div>
  `).join("");
}

function renderNow() {
  syncChrome();
  renderTopbar();
  renderSidebar();
  renderStage();
  renderInspector();
  renderPreview();
  renderOverlays();
  renderToasts();
  const panToId = state.panToId;
  state.panToId = null;
  if (panToId && state.view === "workspace") centerNode(panToId, { animate: true });
  else if (state.needsFit && state.view === "workspace") {
    requestAnimationFrame(() => {
      if (fitGraph({ animate: !state.didFitOnce })) state.needsFit = false;
    });
  }
}

function moveSelection(direction) {
  const current = selectedTimeline();
  if (!current) return;
  if (direction === "ArrowRight") {
    const child = childrenOf(current.id)[0];
    if (child) selectTimeline(child.id);
    return;
  }
  if (direction === "ArrowLeft" && current.parent_id && byId(current.parent_id)) {
    selectTimeline(current.parent_id);
    return;
  }
  if (direction === "ArrowUp" || direction === "ArrowDown") {
    const siblings = current.parent_id ? childrenOf(current.parent_id) : state.timelines.filter((timeline) => !timeline.parent_id || !byId(timeline.parent_id));
    const index = siblings.findIndex((timeline) => timeline.id === current.id);
    const next = siblings[index + (direction === "ArrowDown" ? 1 : -1)];
    if (next) selectTimeline(next.id);
  }
}

function setView(view) {
  if (!NAV.some((item) => item.id === view)) return;
  state.view = view;
  if (view === "compare") ensureCompareDefaults();
  renderNow();
  if (view === "workspace" && !state.graph.userAdjusted) fitGraph({ animate: false });
}

const actions = {
  "set-view": (element) => setView(element.dataset.view),
  "select-timeline": (element) => selectTimeline(element.dataset.id),
  "select-crumb": (element) => selectTimeline(element.dataset.id, { pan: true }),
  "focus-timeline": (element) => {
    state.view = "workspace";
    selectTimeline(element.dataset.id, { pan: true });
  },
  "show-active": () => {
    state.view = "workspace";
    if (state.activeTimelineId) selectTimeline(state.activeTimelineId, { pan: true });
    else renderNow();
  },
  "enter-timeline": (element) => enterTimeline(element.dataset.id || state.selectedId),
  "return-parent": () => returnToParent(),
  "open-composer": (element) => openComposer(element.dataset.id || state.selectedId),
  "close-composer": () => {
    state.composer.open = false;
    renderNow();
    if (state.previousFocus && state.previousFocus.focus) state.previousFocus.focus();
  },
  "set-modification": (element) => setModification(element.dataset.modification),
  "confirm-timeline": (element) => confirmTimeline(element.dataset.id || state.selectedId),
  "ask-decline": (element) => askDecline(element.dataset.id || state.selectedId),
  "ask-restore": (element) => askRestore(element.dataset.id || state.selectedId, element.dataset.snapshotId),
  "create-snapshot": (element) => createSnapshot(element.dataset.id || state.selectedId),
  "refresh-snapshots": (element) => ensureSnapshot(element.dataset.id || state.selectedId, true),
  "dialog-cancel": () => {
    state.dialog = null;
    renderNow();
    if (state.previousFocus && state.previousFocus.focus) state.previousFocus.focus();
  },
  "dialog-confirm": () => confirmDialog(),
  "dismiss-toast": (element) => dismissToast(element.dataset.id),
  "zoom-in": () => zoomBy(1.1),
  "zoom-out": () => zoomBy(1 / 1.1),
  "zoom-fit": () => {
    state.graph.userAdjusted = false;
    fitGraph({ animate: true });
  },
  refresh: () => refreshAll(),
  retry: () => refreshAll(),
  "preview-reload": () => {
    bumpPreview();
    renderNow();
  },
  "preview-expand": () => {
    state.preview.expanded = true;
    renderNow();
  },
  "preview-collapse": () => {
    state.preview.expanded = false;
    renderNow();
  },
  "toggle-section": (element) => {
    const sectionId = element.dataset.section;
    state.collapsed[sectionId] = !state.collapsed[sectionId];
    renderNow();
  },
  "toggle-details": () => {
    state.detailsOpen = !state.detailsOpen;
    renderNow();
  },
  "inspector-backdrop": () => {
    state.detailsOpen = false;
    renderNow();
  },
  "promote-unavailable": () => {
    toast("info", "Promotion is not available in this milestone. Confirming a future keeps it without merging or replacing the original project.");
  },
  "copy-id": async (element) => {
    const id = element.dataset.id || "";
    try {
      await navigator.clipboard.writeText(id);
      toast("success", "Copied timeline id.");
    } catch {
      toast("info", id);
    }
  },
};

function onKeydown(event) {
  if (event.key === "Tab") {
    const layer = document.querySelector("[data-trap='open']");
    if (!layer) return;
    const focusable = [...layer.querySelectorAll("button, input, select, textarea, [href], [tabindex]")].filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true" && element.tabIndex !== -1 && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }

  if (event.key === "Escape") {
    if (state.dialog) {
      actions["dialog-cancel"]();
      return;
    }
    if (state.composer.open) {
      actions["close-composer"]();
      return;
    }
    if (state.preview.expanded) {
      actions["preview-collapse"]();
      return;
    }
    if (state.detailsOpen && isNarrow()) {
      actions["inspector-backdrop"]();
    }
    return;
  }

  if (event.target.id === "preview-resizer" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    state.preview.height = clamp(state.preview.height + (event.key === "ArrowUp" ? 24 : -24), 160, Math.round(window.innerHeight * 0.62));
    syncChrome();
    return;
  }

  if (isTyping(event) || state.composer.open || state.dialog) return;

  const focusedNode = event.target.closest && event.target.closest(".node");
  if (focusedNode && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectTimeline(focusedNode.dataset.id);
    return;
  }

  const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  if (arrows.includes(event.key) && state.view === "workspace") {
    event.preventDefault();
    moveSelection(event.key);
    return;
  }

  const key = event.key.toLowerCase();
  if (key === "c") openComposer(state.selectedId);
  else if (key === "e") enterTimeline(state.selectedId);
  else if (key === "f" || event.key === "0") {
    state.graph.userAdjusted = false;
    state.view = "workspace";
    renderNow();
    fitGraph({ animate: true });
  } else if (key === "p") {
    state.preview.expanded = !state.preview.expanded;
    renderNow();
  } else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.1);
  else if (event.key === "=" || event.key === "+") zoomBy(1.1);
  else if (key >= "1" && key <= "5") setView(NAV[Number(key) - 1].id);
}

function onPointerDown(event) {
  if (event.button != null && event.button !== 0) return;
  const resizer = event.target.closest("#preview-resizer");
  if (resizer && !state.preview.expanded) {
    resizer.setPointerCapture(event.pointerId);
    resizer.dataset.dragging = "true";
    resizer.dataset.startY = String(event.clientY);
    resizer.dataset.startH = String(state.preview.height);
    return;
  }
  const board = event.target.closest("#graph-board");
  if (!board || event.target.closest(".graph-toolbar, button, a, input, select, textarea")) return;
  const node = event.target.closest(".node");
  board.setPointerCapture(event.pointerId);
  board.classList.add("is-panning");
  board.dataset.pointer = String(event.pointerId);
  board.dataset.startX = String(event.clientX);
  board.dataset.startY = String(event.clientY);
  board.dataset.panX = String(state.graph.panX);
  board.dataset.panY = String(state.graph.panY);
  board.dataset.moved = "false";
  board.dataset.nodeId = node ? node.dataset.id : "";
}

function onPointerMove(event) {
  const resizer = document.getElementById("preview-resizer");
  if (resizer && resizer.dataset.dragging === "true") {
    const delta = Number(resizer.dataset.startY) - event.clientY;
    state.preview.height = clamp(Number(resizer.dataset.startH) + delta, 160, Math.round(window.innerHeight * 0.62));
    syncChrome();
    return;
  }
  const board = document.getElementById("graph-board");
  if (!board || board.dataset.pointer !== String(event.pointerId)) return;
  const dx = event.clientX - Number(board.dataset.startX);
  const dy = event.clientY - Number(board.dataset.startY);
  if (Math.abs(dx) + Math.abs(dy) > 4) board.dataset.moved = "true";
  if (!board.dataset.nodeId || board.dataset.moved === "true") {
    state.graph.panX = Number(board.dataset.panX) + dx;
    state.graph.panY = Number(board.dataset.panY) + dy;
    state.graph.userAdjusted = true;
    applyCamera();
  }
}

function onPointerUp(event) {
  const resizer = document.getElementById("preview-resizer");
  if (resizer && resizer.dataset.dragging === "true") {
    resizer.dataset.dragging = "false";
    return;
  }
  const board = document.getElementById("graph-board");
  if (!board || board.dataset.pointer !== String(event.pointerId)) return;
  board.classList.remove("is-panning");
  const nodeId = board.dataset.nodeId;
  const moved = board.dataset.moved === "true";
  board.dataset.pointer = "";
  if (nodeId && !moved) selectTimeline(nodeId);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const element = event.target.closest("[data-action]");
    if (!element || element.disabled) return;
    const action = actions[element.dataset.action];
    if (!action) return;
    if (element.dataset.action !== "set-modification") event.preventDefault();
    action(element, event);
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id === "composer-form") submitComposer(event);
  });
  document.addEventListener("input", (event) => {
    if (event.target.id !== "future-name") return;
    state.composer.name = event.target.value;
    state.composer.nameTouched = true;
    const counter = document.getElementById("name-count");
    if (counter) counter.textContent = `${event.target.value.trim().length}/120`;
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "future-parent") state.composer.parentId = event.target.value;
    if (event.target.id === "compare-left" || event.target.id === "compare-right") {
      const key = event.target.id === "compare-left" ? "leftId" : "rightId";
      state.compare[key] = event.target.value;
      ensureSnapshot(event.target.value);
      renderNow();
    }
  });
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);
  document.addEventListener("wheel", (event) => {
    const board = event.target.closest && event.target.closest("#graph-board");
    if (!board) return;
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.06 : 0.94);
    else {
      state.graph.panX -= event.deltaX;
      state.graph.panY -= event.deltaY;
      state.graph.userAdjusted = true;
      applyCamera();
    }
  }, { passive: false });
}

async function boot() {
  bindEvents();
  renderNow();
  await Promise.all([refreshHealth({ quiet: true }), refreshTimelines({ quiet: true })]);
  state.bootstrapped = true;
  if (state.selectedId) ensureSnapshot(state.selectedId);
  bumpPreview();
  renderNow();
  if (state.connected) logActivity("info", "Connected to the Paradox engine.");
  else note("error", state.healthError || state.listError || "Cannot reach the Paradox engine.");
  window.setInterval(() => {
    if (state.busy || document.hidden) return;
    refreshHealth({ quiet: true }).then(() => {
      renderTopbar();
      if (state.view === "settings") renderStage();
      else renderInspector();
    });
  }, 5000);
  window.setInterval(async () => {
    if (state.busy || document.hidden) return;
    const before = `${state.activeTimelineId}|${state.appUrl}|${state.timelines.map((timeline) => [timeline.id, timeline.status, timeline.name, timeline.is_active, timeline.snapshot_id].join(":")).join("|")}`;
    await refreshTimelines({ quiet: true });
    const after = `${state.activeTimelineId}|${state.appUrl}|${state.timelines.map((timeline) => [timeline.id, timeline.status, timeline.name, timeline.is_active, timeline.snapshot_id].join(":")).join("|")}`;
    if (before !== after) renderNow();
  }, 15000);
}

boot();
