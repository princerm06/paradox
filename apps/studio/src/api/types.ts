export type TimelineStatus = "pending" | "confirmed" | "declined";

export type Modification = "popular_feed" | "none" | "ai" | null;

export type Timeline = {
  id: string;
  parent_id: string | null;
  name: string;
  status: TimelineStatus | string;
  created_at: string;
  snapshot_id: string | null;
  modification: Modification;
  is_active: boolean;
  generation_id: string | null;
};

export type TimelineList = {
  timelines: Timeline[];
  active_timeline_id: string | null;
  app_url: string;
};

export type Health = {
  status: string;
  active_timeline_id: string | null;
  runtime_running: boolean;
};

export type Snapshot = {
  id: string;
  timeline_id: string;
  created_at: string;
};

export type SnapshotList = {
  snapshots: Snapshot[];
};

export type Provider = {
  id: string;
  available: boolean;
  reason: string | null;
};

export type AgentList = {
  default: string;
  providers: Provider[];
};

export type GenerationStatus =
  | "queued"
  | "preparing"
  | "generating"
  | "validating"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GenerationCheck = {
  name: string;
  status: string;
  duration_ms?: number | null;
  detail?: string | null;
};

export type Generation = {
  id: string;
  parent_id: string;
  name: string;
  prompt: string;
  provider: string;
  status: GenerationStatus | string;
  timeline_id: string | null;
  base_snapshot_id: string | null;
  activate_on_success: boolean;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  agent: Record<string, unknown> | null;
  changes: Record<string, unknown> | null;
  evaluation: {
    passed?: boolean;
    checks?: GenerationCheck[];
    tests?: { passed?: number; failed?: number; errors?: number } | null;
    boot_ms?: number | null;
  } | null;
  error: { stage?: string; message?: string } | null;
};

export type GenerationList = {
  generations: Generation[];
};

export type LogStream = {
  stream: "agent" | "validation" | string;
  lines: string[];
};

export type SproutModification = "popular_feed" | "none";

export type Detail =
  | string
  | Array<string | { loc?: Array<string | number>; msg?: string; message?: string }>
  | { message?: string; msg?: string }
  | null;
