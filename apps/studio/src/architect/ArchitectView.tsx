import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentList } from "../api/types.ts";
import { ChangeCount, DiffView, FileStatusMark, LoadingLine, Notice, Provenance } from "../evidence/EvidenceViews.tsx";
import { timelineById } from "../graph/tree.ts";
import { useGenerationDiff, useGenerationRecord, useOpenApi } from "../hooks/evidence.ts";
import { useResource } from "../hooks/useResource.ts";
import { reportedFiles } from "../lib/diff.ts";
import { generationStageLabel, modificationLabel } from "../lib/format.ts";
import { isActiveGeneration } from "../lib/generation.ts";
import { resolveSubject, subjectKey, subjectOptions, timelineOrigin } from "../lib/subject.ts";
import { useNavigation, type Subject } from "../shell/navigation.tsx";
import { useEngine } from "../state/engine.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { ArchCanvas, ComponentIcon } from "./ArchCanvas.tsx";
import { buildSystemModel, changeEntries, listEndpoints, schemaFields, schemaName, resolveSchema, type ArchModel, type ArchNode, type ChangeEntry, type Endpoint } from "./model.ts";

type Lens = "system" | "endpoints" | "changes";
type Picked = { kind: "node"; id: string } | { kind: "endpoint"; id: string } | { kind: "file"; path: string } | null;

export function ArchitectView({ onConsumed }: { onConsumed: () => void }) {
  const workspace = useWorkspace();
  const navigation = useNavigation();
  const [lens, setLens] = useState<Lens>("system");
  const [picked, setPicked] = useState<Picked>(null);
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => {
    inspector.current?.scrollTo?.({ top: 0 });
  }, [picked, lens]);
  const [chosen, setSubject] = useState<Subject | null>(() => navigation.pendingArchitect);
  // Until the user picks, follow the Explore selection (which defaults to the live future).
  const subject: Subject | null =
    chosen ?? (workspace.selectedGenerationId ? { kind: "generation", id: workspace.selectedGenerationId } : workspace.selectedId ? { kind: "timeline", id: workspace.selectedId } : null);

  useEffect(() => {
    if (!navigation.pendingArchitect) return;
    setSubject(navigation.pendingArchitect);
    setLens("changes");
    setPicked(null);
    onConsumed();
  }, [navigation.pendingArchitect, onConsumed]);

  const resolved = resolveSubject(subject, workspace.timelines, workspace.generations);
  const record = useGenerationRecord(resolved?.generationId ?? null, resolved?.generation ?? null);
  const generation = record.record;
  const diff = useGenerationDiff(resolved?.generationId ?? null, generation ? `${generation.status}:${generation.updated_at}` : "");
  const openapi = useOpenApi(workspace.connected ? "on" : "off");
  const { api, base } = useEngine();
  const loadAgents = useCallback((signal: AbortSignal) => api.agents(signal), [api]);
  const agents = useResource<AgentList>(workspace.connected ? `${base}|agents` : null, loadAgents, "", "Agent providers could not be loaded.");
  const files = reportedFiles(generation);
  const entries = useMemo(() => changeEntries(files, diff.status === "ready" ? diff.data : null), [files, diff.status, diff.data]);
  const active = timelineById(workspace.timelines, workspace.activeTimelineId);

  const model = useMemo(
    () =>
      buildSystemModel({
        studioOrigin: window.location.origin,
        apiBase: base,
        health: workspace.health,
        connected: workspace.connected,
        agents: agents.status === "ready" ? agents.data : null,
        openapi: openapi.status === "ready" ? openapi.data : null,
        timelines: workspace.timelines,
        activeTimeline: active,
        appUrl: workspace.appUrl,
        activeGenerations: workspace.generations.filter((item) => isActiveGeneration(item.status)).length,
        changedFiles: files,
      }),
    [active, agents.data, base, agents.status, files, openapi.data, openapi.status, workspace.appUrl, workspace.connected, workspace.generations, workspace.health, workspace.timelines],
  );
  const endpoints = useMemo(() => listEndpoints(openapi.status === "ready" ? openapi.data : null), [openapi.data, openapi.status]);
  const options = subjectOptions(workspace.timelines, workspace.generations);

  const pickedNode = picked?.kind === "node" ? model.nodes.find((node) => node.id === picked.id) ?? null : null;
  const pickedEndpoint = picked?.kind === "endpoint" ? endpoints.find((endpoint) => endpoint.id === picked.id) ?? null : null;
  const pickedFile = picked?.kind === "file" ? entries.find((entry) => entry.path === picked.path) ?? null : null;

  return (
    <div className="mode-view architect">
      <header className="mode-head glass-panel">
        <div className="mode-title">
          <p className="brand-kicker">Architect / system boundaries</p>
          <h1>System Architecture</h1>
          <p className="fine">Explore the local stack and trace each fact to its source.</p>
        </div>
        <div className="lens-tabs" role="tablist" aria-label="Architecture lens">
          {(
            [
              ["system", "System"],
              ["endpoints", `Endpoints${endpoints.length ? ` (${endpoints.length})` : ""}`],
              ["changes", `Changes${entries.length ? ` (${entries.length})` : ""}`],
            ] as Array<[Lens, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={lens === id}
              className={lens === id ? "lens is-on" : "lens"}
              onClick={() => {
                setLens(id);
                setPicked(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="subject-pick">
          <span className="chip-label">Future</span>
          <select
            value={subjectKey(subject)}
            onChange={(event) => {
              const option = options.find((item) => subjectKey(item.subject) === event.target.value);
              setSubject(option ? option.subject : null);
              setPicked(null);
            }}
            aria-label="Future to overlay"
          >
            {!subject ? <option value="">Choose a future</option> : null}
            {(["Timelines", "Attempts without a timeline"] as const).map((group) => {
              const items = options.filter((item) => item.group === group);
              if (!items.length) return null;
              return (
                <optgroup key={group} label={group}>
                  {items.map((item) => (
                    <option key={subjectKey(item.subject)} value={subjectKey(item.subject)}>
                      {item.label} · {item.detail}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
      </header>

      <section className="arch-stage glass-panel" aria-label="Architecture map">
        <div className="arch-map-heading">
          <div><span className="brand-kicker">{lens === "system" ? "Paradox local stack" : lens === "endpoints" ? "Engine API surface" : "Future change map"}</span><p>{lens === "system" ? "System context, not an imported-project topology." : lens === "endpoints" ? "Operations reported by the live OpenAPI schema." : "Generation records and diffs, without inferred runtime claims."}</p></div>
          <span className="arch-scope">Read-only inspection</span>
        </div>
        {lens === "system" ? (
          <>
            <ArchCanvas model={model} selectedId={pickedNode?.id ?? null} onSelect={(id) => setPicked({ kind: "node", id })} />
            <Legend touched={files.length > 0} subjectName={resolved?.name ?? null} />
          </>
        ) : null}
        {lens === "endpoints" ? (
          <EndpointMap state={openapi.status} error={openapi.error} endpoints={endpoints} selectedId={pickedEndpoint?.id ?? null} onSelect={(id) => setPicked({ kind: "endpoint", id })} onRetry={openapi.reload} />
        ) : null}
        {lens === "changes" ? (
          <ChangeMap
            resolvedName={resolved?.name ?? null}
            origin={resolved?.timeline ? timelineOrigin(resolved.timeline) : resolved ? "ai" : null}
            modification={resolved?.timeline?.modification ?? null}
            hasGeneration={Boolean(resolved?.generationId)}
            recordError={record.error}
            diffState={diff.status}
            diffError={diff.error}
            diffText={diff.status === "ready" ? diff.data : null}
            entries={entries}
            selectedPath={pickedFile?.path ?? null}
            onSelect={(path) => setPicked({ kind: "file", path })}
            statusText={generation ? generationStageLabel(generation) : null}
          />
        ) : null}
      </section>

      <aside className="arch-inspector glass-panel" aria-label="Architecture inspector" ref={inspector}>
        <div className="arch-inspector-heading"><span className="brand-kicker">Component inspector</span><span className="fine">Source-backed evidence</span></div>
        {pickedNode ? <NodeDetail node={pickedNode} model={model} entries={entries} onNode={(id) => setPicked({ kind: "node", id })} onFile={(path) => { setLens("changes"); setPicked({ kind: "file", path }); }} /> : null}
        {pickedEndpoint ? <EndpointDetail endpoint={pickedEndpoint} openapi={openapi.status === "ready" ? openapi.data : null} /> : null}
        {pickedFile ? <FileDetail entry={pickedFile} generationProvider={generation?.provider ?? null} /> : null}
        {!picked || (!pickedNode && !pickedEndpoint && !pickedFile) ? (
          <div className="arch-empty">
            <span className="arch-detail-icon"><ComponentIcon kind="service" /></span>
            <h2>{lens === "system" ? "Select a boundary" : lens === "endpoints" ? "Select an endpoint" : "Select a changed file"}</h2>
            <p className="fine">
              {lens === "system"
                ? "Each box is a real component of Paradox's local stack, labelled with where that fact comes from."
                : lens === "endpoints"
                  ? "Endpoints come from the engine's live OpenAPI schema."
                  : "Files come from the selected future's generation record and unified diff."}
            </p>
          </div>
        ) : null}
        <Unavailable />
        {resolved ? (
          <div className="context-links">
            <button type="button" className="text-btn" onClick={() => (resolved.subject.kind === "timeline" ? navigation.inspectTimeline(resolved.subject.id) : navigation.inspectGeneration(resolved.subject.id))}>
              Inspect {resolved.name} in Explore →
            </button>
            <button type="button" className="text-btn" onClick={() => navigation.compare(resolved.subject)}>
              Compare in Analyze →
            </button>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function Legend({ touched, subjectName }: { touched: boolean; subjectName: string | null }) {
  return (
    <div className="arch-legend">
      <span>
        <i className="lg observed" /> Observed live
      </span>
      <span>
        <i className="lg documented" /> Documented contract
      </span>
      <span>
        <i className="lg inferred" /> Inferred from file paths
      </span>
      <span><i className="lg no-source" /> Unavailable · not measured</span>
      {touched && subjectName ? (
        <span>
          <i className="lg change" /> Touched by {subjectName}
        </span>
      ) : null}
    </div>
  );
}

function Unavailable() {
  return (
    <div className="unavailable">
      <p><Provenance kind="unavailable" /> <span className="brand-kicker">Coverage limits</span></p>
      <ul>
        <li>Source-level dependency or import graph</li>
        <li>Live latency, throughput, error-rate or resource metrics</li>
        <li>Per-component health beyond engine and runtime</li>
        <li>Imported-project topology and architecture comparison</li>
      </ul>
      <p className="fine">These capabilities have no connected evidence source in this workspace. Missing evidence is not guessed.</p>
    </div>
  );
}

function NodeDetail({ node, model, entries, onFile, onNode }: { node: ArchNode; model: ArchModel; entries: ChangeEntry[]; onFile: (path: string) => void; onNode: (id: string) => void }) {
  const touched = entries.filter((entry) => node.touched?.includes(entry.path));
  const relationships = model.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  return (
    <div className="arch-detail">
      <span className="arch-detail-icon"><ComponentIcon kind={node.kind} /></span>
      <p className="brand-kicker">{node.kind}</p>
      <h2>{node.label}</h2>
      <p className="fine">{node.sub}</p>
      <p>
        <Provenance kind={node.prov} source={node.source} />
      </p>
      <dl className="facts">
        {node.details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {node.notes?.map((note) => (
        <p key={note} className="fine">
          {note}
        </p>
      ))}
      {relationships.length ? <section className="arch-relationships">
        <h3>System relationships</h3>
        {relationships.map((edge) => {
          const other = model.nodes.find((item) => item.id === (edge.from === node.id ? edge.to : edge.from));
          return other ? <div key={edge.id}>
            <button type="button" className="text-btn" onClick={() => onNode(other.id)}>{edge.from === node.id ? "→" : "←"} {other.label}</button>
            {edge.label ? <span className="fine">{edge.label}</span> : null}
            <Provenance kind={edge.prov} source={edge.source} />
          </div> : null;
        })}
      </section> : null}
      {touched.length ? (
        <section>
          <h3>
            Touched by the selected future <Provenance kind="inferred" source="path prefix demo_app/" />
          </h3>
          <ul className="file-list">
            {touched.map((entry) => (
              <li key={entry.path}>
                <FileStatusMark status={entry.status} />
                <button type="button" className="file-path linkish" onClick={() => onFile(entry.path)}>
                  {entry.path}
                </button>
                <ChangeCount additions={entry.additions} deletions={entry.deletions} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EndpointMap({
  state,
  error,
  endpoints,
  selectedId,
  onSelect,
  onRetry,
}: {
  state: string;
  error: string | null;
  endpoints: Endpoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  if (state === "loading") return <LoadingLine label="Reading the engine's OpenAPI schema" />;
  if (state === "error")
    return (
      <Notice tone="error" action={<button type="button" className="btn" onClick={onRetry}>Retry</button>}>
        {error} Endpoint topology needs <code>GET /openapi.json</code>.
      </Notice>
    );
  if (state === "idle") return <Notice>The engine is offline, so its schema cannot be read.</Notice>;
  const groups = [...new Set(endpoints.map((endpoint) => endpoint.group))];
  return (
    <div className="endpoint-map">
      <p className="source-line">
        <Provenance kind="observed" source="GET /openapi.json" /> {endpoints.length} operations. The app proxy <code>/app/*</code> is excluded from the schema by the engine.
      </p>
      <div className="endpoint-groups">
        {groups.map((group) => (
          <section key={group} className="endpoint-group">
            <h3>{group}</h3>
            <ul>
              {endpoints
                .filter((endpoint) => endpoint.group === group)
                .map((endpoint) => (
                  <li key={endpoint.id}>
                    <button type="button" className={selectedId === endpoint.id ? "endpoint is-on" : "endpoint"} aria-pressed={selectedId === endpoint.id} onClick={() => onSelect(endpoint.id)}>
                      <span className={`verb verb-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                      <span className="endpoint-path">{endpoint.path.replace(group, "") || "/"}</span>
                      {endpoint.usedByStudio ? <span className="used" title="Called by this studio">●</span> : <span className="unused" title="Not called by this studio">○</span>}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function EndpointDetail({ endpoint, openapi }: { endpoint: Endpoint; openapi: import("../api/types.ts").OpenApiDoc | null }) {
  const body = endpoint.operation.requestBody?.content?.["application/json"]?.schema;
  const responses = Object.entries(endpoint.operation.responses ?? {});
  return (
    <div className="arch-detail">
      <p className="brand-kicker">Endpoint</p>
      <h2 className="mono">
        <span className={`verb verb-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span> {endpoint.path}
      </h2>
      <p className="fine">{endpoint.summary}</p>
      <p>
        <Provenance kind="observed" source="GET /openapi.json" />
      </p>
      <dl className="facts">
        <div>
          <dt>Studio</dt>
          <dd>{endpoint.usedByStudio ? "Called by this studio" : "Not called by this studio"}</dd>
        </div>
        <div>
          <dt>Auth</dt>
          <dd>{endpoint.mutating ? "Bearer token when PARADOX_TOKEN is set" : "None (reads are open locally)"}</dd>
        </div>
      </dl>
      {endpoint.operation.parameters?.length ? (
        <section>
          <h3>Parameters</h3>
          <ul className="field-list">
            {endpoint.operation.parameters.map((parameter) => (
              <li key={`${parameter.in}:${parameter.name}`}>
                <code>{parameter.name}</code>
                <span className="fine">
                  {parameter.in} · {schemaName(parameter.schema)}
                  {parameter.required ? " · required" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {body ? (
        <section>
          <h3>Request · {schemaName(body)}</h3>
          <FieldList fields={schemaFields(openapi, body)} />
        </section>
      ) : null}
      <section>
        <h3>Responses</h3>
        {responses.map(([code, response]) => {
          const schema = response.content?.["application/json"]?.schema ?? response.content?.["text/plain"]?.schema;
          const resolved = resolveSchema(openapi, schema);
          return (
            <div key={code} className="response">
              <p>
                <span className={code.startsWith("2") ? "code ok" : "code bad"}>{code}</span> {response.description}
                {schema ? <span className="fine"> · {schemaName(schema)}</span> : null}
                {response.content?.["text/plain"] ? <span className="fine"> · text/plain</span> : null}
              </p>
              {resolved?.properties ? <FieldList fields={schemaFields(openapi, schema)} /> : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function FieldList({ fields }: { fields: Array<{ name: string; type: string; required: boolean }> }) {
  if (!fields.length) return <p className="fine">No declared fields.</p>;
  return (
    <ul className="field-list">
      {fields.map((field) => (
        <li key={field.name}>
          <code>{field.name}</code>
          <span className="fine">
            {field.type}
            {field.required ? " · required" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChangeMap({
  resolvedName,
  origin,
  modification,
  hasGeneration,
  recordError,
  diffState,
  diffError,
  diffText,
  entries,
  selectedPath,
  onSelect,
  statusText,
}: {
  resolvedName: string | null;
  origin: string | null;
  modification: string | null;
  hasGeneration: boolean;
  recordError: string | null;
  diffState: string;
  diffError: string | null;
  diffText: string | null;
  entries: ChangeEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  statusText: string | null;
}) {
  if (!resolvedName) return <Notice>Choose a future to see the files it changed.</Notice>;
  if (!hasGeneration) {
    return (
      <Notice>
        {origin === "root"
          ? `${resolvedName} is the root codebase; it has no change set.`
          : origin === "sprout"
            ? `${resolvedName} was made by an engine sprout (${modificationLabel(modification as never)}). The engine records no file-level change set for sprouts; the documented popular_feed sprout replaces demo_app/ranking.py with an engine template.`
            : `${resolvedName} has no generation record, so no file-level changes are available.`}
      </Notice>
    );
  }
  const dirs = [...new Set(entries.map((entry) => entry.dir))];
  return (
    <div className="change-map">
      <p className="source-line">
        <Provenance kind="observed" source="generation.changes + /diff" /> Files {resolvedName} changed relative to its base snapshot{statusText ? ` · ${statusText}` : ""}.
      </p>
      {recordError ? <Notice tone="error">{recordError}</Notice> : null}
      {diffState === "loading" ? <LoadingLine label="Loading the diff" /> : null}
      {diffState === "error" ? <Notice tone="error">Diff: {diffError} File list below comes from the generation record only.</Notice> : null}
      {entries.length === 0 && diffState !== "loading" ? <Notice>No changed files recorded for this generation.</Notice> : null}
      <div className="change-dirs">
        {dirs.map((dir) => (
          <section key={dir} className="change-dir">
            <h3>
              <span aria-hidden="true">▤</span> {dir}/
            </h3>
            <ul>
              {entries
                .filter((entry) => entry.dir === dir)
                .map((entry) => (
                  <li key={entry.path}>
                    <button type="button" className={selectedPath === entry.path ? "change-file is-on" : "change-file"} aria-pressed={selectedPath === entry.path} onClick={() => onSelect(entry.path)}>
                      <FileStatusMark status={entry.status} />
                      <span className="file-path">{entry.path.slice(dir === "." ? 0 : dir.length + 1)}</span>
                      <ChangeCount additions={entry.additions} deletions={entry.deletions} />
                      {entry.mapsTo ? <span className="maps-to" title="Inferred from the file path">→ {entry.mapsTo === "seam" ? "ranking seam" : entry.mapsTo === "validation" ? "test suite" : "demo runtime"}</span> : null}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      {diffText && diffText.trim() ? (
        <section className="change-diff">
          <h3>
            {selectedPath ? <>Diff · <span className="mono">{selectedPath}</span></> : "Full diff"}
            <span className="fine"> against the generation's base snapshot</span>
          </h3>
          <DiffView text={diffText} focusPath={selectedPath} />
        </section>
      ) : null}
    </div>
  );
}

function FileDetail({ entry, generationProvider }: { entry: ChangeEntry; generationProvider: string | null }) {
  return (
    <div className="arch-detail">
      <p className="brand-kicker">Changed file</p>
      <h2 className="mono">{entry.path}</h2>
      <p>
        <Provenance kind="observed" source="generation.changes" />
        {entry.mapsTo ? <Provenance kind="inferred" source={`maps to ${entry.mapsTo} by path`} /> : null}
      </p>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{entry.status}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>
            <ChangeCount additions={entry.additions} deletions={entry.deletions} />
          </dd>
        </div>
        {generationProvider ? (
          <div>
            <dt>Author</dt>
            <dd>{generationProvider} agent</dd>
          </div>
        ) : null}
      </dl>
      {entry.diff ? (
        <section>
          <h3>Hunks</h3>
          <ul className="field-list">
            {entry.diff.hunks.map((hunk) => (
              <li key={hunk.header}>
                <code>{hunk.header}</code>
                <span className="fine">{hunk.lines.filter((line) => line.kind !== "ctx").length} changed lines</span>
              </li>
            ))}
          </ul>
          <p className="fine">The hunks are shown in the stage.</p>
        </section>
      ) : (
        <p className="fine">No hunks for this file in the unified diff.</p>
      )}
    </div>
  );
}
