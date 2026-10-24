import type { Generation, Modification, Timeline } from "../api/types.ts";

export function isTerminalGeneration(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function generationStageLabel(generation: Generation): string {
  if (generation.status === "failed") {
    return generation.error?.stage ? `Failed · ${generation.error.stage}` : "Failed";
  }
  if (generation.status === "cancelled") return "Cancelled";
  if (generation.status === "queued") return "Queued";
  if (generation.status === "preparing") return "Preparing";
  if (generation.status === "generating") return "Generating";
  if (generation.status === "validating") return "Validating";
  if (generation.status === "succeeded") return "Succeeded";
  return generation.status || "Unknown";
}

export function modificationLabel(value: Modification | undefined): string {
  if (value === "popular_feed") return "Popular feed";
  if (value === "none") return "Unchanged fork";
  if (value === "ai") return "AI generation";
  if (value == null) return "None recorded";
  return String(value);
}

export function statusLabel(timeline: Timeline): string {
  if (!timeline.parent_id) return "Root";
  if (timeline.status === "pending") return "Pending";
  if (timeline.status === "confirmed") return "Confirmed";
  if (timeline.status === "declined") return "Declined";
  return timeline.status || "Unknown";
}

export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}
