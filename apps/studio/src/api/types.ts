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

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | string;
  additions?: number | null;
  deletions?: number | null;
};

export type GenerationAgent = {
  exit_code?: number | null;
  session_id?: string | null;
  duration_ms?: number | null;
  summary?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null; factory_credits?: number | null } | null;
};

export type GenerationEvaluation = {
  passed?: boolean;
  checks?: GenerationCheck[];
  tests?: { passed?: number; failed?: number; errors?: number } | null;
  boot_ms?: number | null;
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
  agent: GenerationAgent | null;
  changes: { files?: ChangedFile[] } | null;
  evaluation: GenerationEvaluation | null;
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

/** Minimal OpenAPI 3 shape the studio reads from the engine's `/openapi.json`. */
export type OpenApiDoc = {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation | undefined>>;
  components?: { schemas?: Record<string, OpenApiSchema> };
};

export type OpenApiOperation = {
  summary?: string;
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: OpenApiSchema }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: OpenApiSchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: OpenApiSchema }> }>;
};

export type OpenApiSchema = {
  $ref?: string;
  type?: string;
  title?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  enum?: unknown[];
  anyOf?: OpenApiSchema[];
  default?: unknown;
};
