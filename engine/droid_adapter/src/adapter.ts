/**
 * Paradox <-> Factory Droid adapter.
 *
 * Runs one Droid turn through the official `@factory/droid-sdk` Node API
 * (`createSession` + `session.stream`). The Python engine launches this file
 * as a subprocess:
 *
 *   stdin   one JSON object: {"cwd": string, "prompt": string}
 *   stdout  JSON Lines:      {"type":"log","message":string}*
 *                            {"type":"result","exit_code":number,"session_id":string|null,
 *                             "summary":string|null,"usage":{...}}   (exactly one, last)
 *   stderr  sanitized diagnostics only
 *
 *   node dist/adapter.js --probe   exits 0 iff the SDK loads and a `droid`
 *                                  executable is resolvable. No API key needed.
 *
 * Authentication is FACTORY_API_KEY from the environment only; the SDK reads it
 * itself. This file never prints or forwards the key.
 */

import { accessSync, closeSync, constants as fsConstants, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  createSession as CreateSessionFn,
  CreateSessionOptions,
  DroidSession,
  RequestPermissionHandlerResult,
} from '@factory/droid-sdk/node';

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

export interface AdapterInput {
  cwd: string;
  prompt: string;
  project?: ProjectPolicy;
}

export interface ProjectPolicy {
  adapter: 'fastapi-sqlite-v1';
  editable_prefixes: string[];
  immutable_paths: string[];
  protected_files: string[];
}

export interface AdapterUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  factory_credits: number | null;
}

export interface LogMessage {
  type: 'log';
  message: string;
}

export interface ResultMessage {
  type: 'result';
  exit_code: number;
  session_id: string | null;
  summary: string | null;
  usage: AdapterUsage;
}

export type AdapterMessage = LogMessage | ResultMessage;

export const EXIT_OK = 0;
export const EXIT_RUN_FAILED = 1;
export const EXIT_BAD_INPUT = 2;
export const EXIT_SDK_UNAVAILABLE = 3;
export const EXIT_INTERRUPTED = 130;

const MAX_LOG_CHARS = 2000;
const MAX_SUMMARY_CHARS = 8000;
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Tool policy
// ---------------------------------------------------------------------------

/**
 * Tool IDs removed from the session before it starts (`disabledToolIds`).
 * The SDK only exposes a subtractive list, so this names every non-file tool
 * known to @factory/droid-sdk 0.10.0 (droid-sdk-core TOOL_LLM_ID_* constants).
 * Tools added by future CLI versions are not covered here; the permission
 * handler below is the backstop for anything that asks for approval.
 */
export const DISABLED_TOOL_IDS: readonly string[] = [
  'Execute',
  'Script',
  'WaitForScript',
  'WebSearch',
  'FetchUrl',
  'GenerateImage',
  'Task',
  'SpawnAgent',
  'ListAgents',
  'SendMessage',
  'InterruptAgent',
  'AskUser',
  'ConnectorSearch',
  'ConnectApp',
  'ProposeWorkstream',
  'CreateWorkstream',
  'StageSettingsChanges',
  'RecommendMission',
  'ProposeMission',
  'StartMissionRun',
  'SelectFeature',
  'EndFeatureRun',
  'DismissHandoffItems',
  'DecisionModel',
  'getIdeDiagnostics',
];

/** Confirmation detail types the handler may approve (file writes only). */
const EDIT_CONFIRMATION_TYPES = new Set(['edit', 'create', 'apply_patch']);

/** Path segments an approved edit may never touch. */
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);
const IMPORTED_ALLOWED_TOOLS = new Set(['Read', 'Edit', 'Create', 'LS', 'Grep', 'Glob', 'TodoWrite']);
const IMPORTED_CONTROL_NAMES = new Set(['conftest.py', 'pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml', 'sitecustomize.py', 'usercustomize.py', 'agents.md']);
const IMPORTED_AUTOLOAD_NAMES = new Set(['.factory', '.claude', '.agents', '.codex', '.mcp.json']);

const PROCEED_ONCE = 'proceed_once';
const CANCEL = 'cancel';

interface PermissionToolUse {
  toolUse?: { name?: string; input?: Record<string, unknown> };
  confirmationType?: string;
  details?: {
    type?: string;
    filePath?: string;
    files?: Array<{ filePath?: string; moveTo?: string }>;
    [key: string]: unknown;
  };
}

export interface PermissionRequest {
  toolUses: PermissionToolUse[];
  options: Array<{ value: string; label?: string }>;
}

export interface PermissionDecision {
  outcome: typeof PROCEED_ONCE | typeof CANCEL;
  reason: string;
}

/** Resolve `target` (relative to `root`) through symlinks of its nearest existing ancestor. */
function canonicalize(root: string, target: string): string {
  let current = path.resolve(root, target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(root, target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `target` resolves inside `root` and avoids forbidden segments. */
export function isEditablePath(root: string, target: unknown): boolean {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    return false;
  }
  const realRoot = canonicalize(root, '.');
  const resolved = canonicalize(realRoot, target);
  const relative = path.relative(realRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return !relative.split(path.sep).some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

function describeToolUse(item: PermissionToolUse): string {
  return item.toolUse?.name ?? item.details?.type ?? item.confirmationType ?? 'unknown';
}

/**
 * Decide a permission request. Approves only when every tool use is a file
 * edit/create/apply_patch whose paths all stay inside `root`; everything else
 * (shell, scripts, MCP, sandbox escapes, missions, ...) is cancelled.
 */
export function decidePermission(root: string, request: PermissionRequest, writeRoot = root): PermissionDecision {
  const offered = new Set((request.options ?? []).map((option) => option.value));
  if (!offered.has(PROCEED_ONCE)) {
    return { outcome: CANCEL, reason: 'proceed_once not offered' };
  }
  const toolUses = request.toolUses ?? [];
  if (toolUses.length === 0) {
    return { outcome: CANCEL, reason: 'empty permission request' };
  }
  for (const item of toolUses) {
    const details = item.details ?? {};
    const kind = details.type ?? item.confirmationType;
    const label = describeToolUse(item);
    if (!kind || !EDIT_CONFIRMATION_TYPES.has(kind)) {
      return { outcome: CANCEL, reason: `tool ${label} (${kind ?? 'unknown'}) is not permitted` };
    }
    const paths: unknown[] = details.filePath === undefined ? [] : [details.filePath];
    if (kind === 'apply_patch' && Array.isArray(details.files)) {
      for (const file of details.files) {
        paths.push(file.filePath);
        if (file.moveTo !== undefined) paths.push(file.moveTo);
      }
    }
    if (paths.length === 0) {
      return { outcome: CANCEL, reason: `tool ${label} has no verifiable file paths` };
    }
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !isEditablePath(writeRoot, path.resolve(root, candidate))) {
        return { outcome: CANCEL, reason: `tool ${label} targets a path outside the workspace` };
      }
    }
  }
  return { outcome: PROCEED_ONCE, reason: `approved ${toolUses.map(describeToolUse).join(', ')}` };
}

function relativePolicyPath(value: unknown, empty = false): value is string {
  return typeof value === 'string' && value.length <= 1024 && (empty || value.length > 0)
    && !path.posix.isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && (value === '' || path.posix.normalize(value) === value)
    && !value.split('/').some((segment) => segment === '..' || segment === '.');
}

export function parseProjectPolicy(value: unknown): ProjectPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid imported-project policy');
  const policy = value as Record<string, unknown>;
  if (policy.adapter !== 'fastapi-sqlite-v1'
      || Object.keys(policy).sort().join(',') !== 'adapter,editable_prefixes,immutable_paths,protected_files') {
    throw new Error('Unsupported imported-project policy');
  }
  for (const name of ['editable_prefixes', 'immutable_paths', 'protected_files']) {
    const values = policy[name];
    if (!Array.isArray(values) || values.length > 10000 || (name === 'editable_prefixes' && !values.length)
        || values.some((entry) => !relativePolicyPath(entry, name === 'editable_prefixes')
          || (name === 'editable_prefixes' && entry !== '' && !entry.endsWith('/'))
          || (name !== 'immutable_paths' && /[*?\[\]]/.test(entry))
          || (name === 'immutable_paths' && /[?\[\]]/.test(entry)))) {
      throw new Error('Invalid imported-project policy ' + name);
    }
  }
  return policy as unknown as ProjectPolicy;
}

function immutableProjectPath(relative: string, policy: ProjectPolicy): boolean {
  const segments = relative.split('/');
  const name = path.posix.basename(relative).toLowerCase();
  return policy.protected_files.includes(relative)
    || IMPORTED_CONTROL_NAMES.has(name) || name.endsWith('.pth')
    || segments.some((segment) => IMPORTED_AUTOLOAD_NAMES.has(segment.toLowerCase()))
    || policy.immutable_paths.some((pattern) => {
      const expression = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp('^' + expression + '$').test(pattern.includes('/') ? relative : path.posix.basename(relative));
    });
}

export function decideProjectPermission(root: string, request: PermissionRequest, policy: ProjectPolicy): PermissionDecision {
  const decision = decidePermission(root, request, root);
  if (decision.outcome !== PROCEED_ONCE) return decision;
  for (const item of request.toolUses) {
    const details = item.details ?? {};
    const paths = [details.filePath, ...(Array.isArray(details.files) ? details.files : []).flatMap((file) => [file.filePath, file.moveTo])]
      .filter((candidate): candidate is string => candidate !== undefined);
    for (const target of paths) {
      const relative = path.relative(realpathSync(root), canonicalize(root, target));
      if (target.includes('\\') || target.split('/').includes('..')
          || !policy.editable_prefixes.some((prefix) => relative.startsWith(prefix))
          || immutableProjectPath(relative, policy)) {
        return { outcome: CANCEL, reason: 'imported-project path is protected or outside editable prefixes' };
      }
    }
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Sanitization / output helpers
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bfk-[A-Za-z0-9_-]{8,}/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi,
  /((?:api[_-]?key|token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/** Redact API keys (including the live FACTORY_API_KEY value) and clamp length. */
export function sanitize(text: string, maxChars = MAX_LOG_CHARS, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  const key = env.FACTORY_API_KEY;
  if (key && key.length >= 4) out = out.split(key).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) && /[:=]/.test(prefix)
        ? `${prefix}[REDACTED]`
        : '[REDACTED]',
    );
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}... [truncated]`;
  return out;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function emptyUsage(): AdapterUsage {
  return { input_tokens: null, output_tokens: null, factory_credits: null };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toUsage(tokenUsage: unknown): AdapterUsage {
  if (!tokenUsage || typeof tokenUsage !== 'object') return emptyUsage();
  const usage = tokenUsage as Record<string, unknown>;
  return {
    input_tokens: finiteOrNull(usage.inputTokens),
    output_tokens: finiteOrNull(usage.outputTokens),
    factory_credits: finiteOrNull(usage.factoryCredits),
  };
}

/** Turn one SDK stream message into a short log line, or null to skip it. */
export function describeStreamMessage(message: Record<string, unknown>): string | null {
  switch (message.type) {
    case 'assistant': {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      return text ? `assistant: ${text}` : null;
    }
    case 'tool_call':
      return `tool_call: ${String(message.name)}`;
    case 'tool_result':
      return `tool_result: ${String(message.toolName)}${message.isError ? ' (error)' : ''}`;
    case 'error':
      return `error: ${String(message.message)}`;
    case 'hook':
      return `hook: ${String(message.status)}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export function parseInput(raw: string): AdapterInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('stdin is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stdin must be a JSON object');
  }
  const { cwd, prompt, project } = value as Record<string, unknown>;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('"cwd" must be an absolute path string');
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('"prompt" must be a non-empty string');
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error('"cwd" does not exist or is not a directory');
  return { cwd: realpathSync(cwd), prompt, ...(project === undefined ? {} : { project: parseProjectPolicy(project) }) };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  createSession: (options: CreateSessionOptions) => Promise<Pick<DroidSession, 'id' | 'settings' | 'updateSettings' | 'listTools' | 'stream' | 'close'>>;
  listModels: typeof import('@factory/droid-sdk/node')['listModels'];
  /** SDK `AutonomyLevel.Off`; injected so tests need not load the SDK. */
  autonomyOff: CreateSessionOptions['autonomyLevel'];
  emit: (message: AdapterMessage) => void;
  diagnostic: (line: string) => void;
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Run one Droid turn and emit protocol messages. Returns the process exit code. */
export async function runAdapter(input: AdapterInput, deps: RunnerDeps): Promise<number> {
  const env = deps.env ?? process.env;
  let permissionCalls = 0;
  const log = (text: string) => deps.emit({ type: 'log', message: sanitize(text, MAX_LOG_CHARS, env) });
  const finish = (exitCode: number, sessionId: string | null, summary: string | null, usage = emptyUsage()) => {
    log(`permission handler audit: invoked=${permissionCalls}`);
    deps.emit({
      type: 'result',
      exit_code: exitCode,
      session_id: sessionId,
      summary: summary === null ? null : sanitize(summary, MAX_SUMMARY_CHARS, env),
      usage,
    });
    return exitCode;
  };

  if (!env.FACTORY_API_KEY) {
    deps.diagnostic('FACTORY_API_KEY is not set');
    return finish(EXIT_BAD_INPUT, null, 'FACTORY_API_KEY is not set');
  }

  const root = input.cwd;
  let project: ProjectPolicy | undefined;
  const modelId = env.PARADOX_DROID_MODEL?.trim() || DEFAULT_MODEL_ID;
  let session: Awaited<ReturnType<RunnerDeps['createSession']>> | null = null;
  try {
    project = input.project === undefined ? undefined : parseProjectPolicy(input.project);
    const disabledTools = [...DISABLED_TOOL_IDS, ...(project ? ['ToolSearch'] : [])];
    let models: Awaited<ReturnType<RunnerDeps['listModels']>>;
    try {
      models = await deps.listModels({ cwd: root, includeDisabled: true });
    } catch (error) {
      throw new Error(`Cannot verify Droid model "${modelId}" availability: ${errorText(error)}`);
    }
    const selectedModel = models.find((model) => model.id === modelId);
    if (!selectedModel) {
      throw new Error(`Droid model "${modelId}" is unavailable. Set PARADOX_DROID_MODEL to a selectable direct-tool model.`);
    }
    if (selectedModel.disabled) {
      throw new Error(`Droid model "${modelId}" is disabled: ${selectedModel.disabledReason}. Check organization model permissions.`);
    }
    session = await deps.createSession({
      cwd: root,
      modelId,
      autonomyLevel: deps.autonomyOff,
      disabledToolIds: disabledTools,
      ...(project ? { mcpServers: [] } : {}),
      autoRejectPermissionRequests: false,
      disableBuiltinSkills: true,
      abortSignal: deps.abortSignal,
      permissionHandler: (params): RequestPermissionHandlerResult => {
        permissionCalls += 1;
        const decision = project
          ? decideProjectPermission(root, params as unknown as PermissionRequest, project)
          : decidePermission(root, params as unknown as PermissionRequest, path.join(root, 'demo_app'));
        log(`permission ${decision.outcome}: ${decision.reason}`);
        return decision.outcome as RequestPermissionHandlerResult;
      },
      // No askUserHandler: the SDK declines AskUser requests without one.
    });
    log(`session started: ${session.id}`);
    const verifySettings = () => {
      if (session!.settings?.toolExecutionMode !== 'direct_only') {
        throw new Error(`Droid model "${modelId}" has effective toolExecutionMode "${session!.settings?.toolExecutionMode ?? 'unknown'}"; direct_only is required. Script remains disabled. Select a compatible PARADOX_DROID_MODEL or update the SDK/CLI if mode metadata is missing.`);
      }
      if (session!.settings.modelId !== modelId) {
        throw new Error(`Requested Droid model "${modelId}" but initialized "${session!.settings.modelId ?? 'unknown'}"; refusing a silent model substitution.`);
      }
      if (session!.settings.autonomyLevel !== deps.autonomyOff) {
        throw new Error(`Droid model "${modelId}" must retain AutonomyLevel.Off; got "${session!.settings.autonomyLevel ?? 'unknown'}". No autonomy escalation is permitted.`);
      }
    };
    verifySettings();
    const overrides = { enabledToolIds: ['Read', 'Edit', 'Create'], disabledToolIds: disabledTools };
    try {
      await session.updateSettings(overrides);
    } catch (error) {
      throw new Error(`Cannot explicitly enable direct file tools for Droid model "${modelId}" with autonomy Off: ${errorText(error)}`);
    }
    verifySettings();
    const mode = session.settings?.toolExecutionMode;
    log(`session model: ${session.settings.modelId}; tool execution mode: ${mode}; autonomy: ${session.settings.autonomyLevel}; explicitly enabled: Read, Edit, Create`);
    let tools: Awaited<ReturnType<DroidSession['listTools']>>;
    try {
      tools = project ? await session.listTools() : await session.listTools({ toolIds: ['Read', 'Edit', 'Create'] });
    } catch (error) {
      throw new Error(`Cannot verify direct file tools for Droid model "${modelId}" (mode ${mode}): ${errorText(error)}`);
    }
    log(`file tool catalog: ${['Read', 'Edit', 'Create'].map((id) => {
      const tool = tools.find((entry) => entry.id === id);
      return tool ? `${id} (allowed=${tool.allowed}, defaultAllowed=${tool.defaultAllowed})` : `${id} (missing)`;
    }).join(', ')}`);
    const unavailableTools = ['Read', 'Edit', 'Create'].filter((id) => !tools.some((tool) => tool.id === id && tool.allowed === true));
    if (unavailableTools.length) {
      throw new Error(`Droid model "${modelId}" (mode ${mode}) lacks allowed required file tools: ${unavailableTools.join(', ')}. Read, Edit and Create must each report allowed=true before streaming. Check model/organization tool permissions; AutonomyLevel.Off and shell restrictions remain unchanged.`);
    }
    if (project) {
      const unexpected = tools.filter((tool) => tool.allowed === true && !IMPORTED_ALLOWED_TOOLS.has(tool.id));
      if (unexpected.length) throw new Error('Imported-project tool catalog contains unexpected allowed tools: ' + unexpected.map((tool) => tool.id).join(', '));
      log('imported-project tool catalog verified; unexpected tools rejected; no scripted fallback');
    }

    for await (const message of session.stream(input.prompt, { abortSignal: deps.abortSignal })) {
      const record = message as unknown as Record<string, unknown>;
      if (record.type === 'result') {
        const usage = toUsage(record.tokenUsage);
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : session.id;
        const text = typeof record.text === 'string' ? record.text.trim() : '';
        if (record.success === true) {
          return finish(EXIT_OK, sessionId, text || null, usage);
        }
        if (record.interrupted === true) {
          return finish(EXIT_INTERRUPTED, sessionId, text || 'Droid turn was interrupted', usage);
        }
        const err = record.error as { message?: unknown } | null | undefined;
        const reason = typeof err?.message === 'string' ? err.message : `Droid turn failed (${String(record.subtype)})`;
        deps.diagnostic(sanitize(reason, MAX_LOG_CHARS, env));
        return finish(EXIT_RUN_FAILED, sessionId, text || reason, usage);
      }
      const line = describeStreamMessage(record);
      if (line) log(line);
    }
    return finish(EXIT_RUN_FAILED, session.id, 'Droid stream ended without a result');
  } catch (error) {
    const aborted = deps.abortSignal?.aborted === true;
    const text = sanitize(errorText(error), MAX_LOG_CHARS, env);
    deps.diagnostic(text);
    return finish(aborted ? EXIT_INTERRUPTED : EXIT_RUN_FAILED, session?.id ?? null, aborted ? 'Droid run aborted' : text);
  } finally {
    if (session) {
      await session.close().catch((error: unknown) => deps.diagnostic(sanitize(`close failed: ${errorText(error)}`)));
    }
  }
}

export function verifyWriteSandbox(root: string, env = process.env, platform = process.platform, project?: ProjectPolicy): void {
  if (project) {
    if (platform !== 'darwin' || env.PARADOX_DROID_SANDBOX !== 'macos-project-write-v1') {
      throw new Error('Imported Droid requires the engine-managed imported-project write sandbox; no unsandboxed fallback');
    }
    parseProjectPolicy(project);
    const outside = path.join(path.dirname(root), `.sdk-outside-denied-${randomUUID()}`);
    let inside: string | undefined;
    let outsideCreated = false;
    try {
      inside = mkdtempSync(path.join(root, '.sdk-inside-allowed-'));
      writeFileSync(path.join(inside, 'probe'), 'allowed');
      try {
        writeFileSync(outside, 'must be denied', { flag: 'wx' });
        outsideCreated = true;
      } catch (error) {
        if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (outsideCreated) throw new Error('Imported Droid sandbox permits writes outside future code');
      for (const relative of project.protected_files) {
        const target = path.join(root, relative);
        if (!isEditablePath(root, target) || !statSync(target).isFile() || statSync(target).nlink !== 1) {
          throw new Error('Imported Droid protected file is unsafe');
        }
        let descriptor: number;
        try {
          descriptor = openSync(target, fsConstants.O_WRONLY);
        } catch (error) {
          if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw error;
        }
        closeSync(descriptor);
        throw new Error('Imported Droid sandbox permits writes to a protected file');
      }
    } finally {
      if (inside) rmSync(inside, { recursive: true, force: true });
      if (outsideCreated) rmSync(outside, { force: true });
    }
    return;
  }
  if (platform !== 'darwin' || env.PARADOX_DROID_SANDBOX !== 'macos-write-v1') {
    throw new Error('Droid requires the engine-managed macOS write sandbox; no unsandboxed fallback');
  }
  const outside = path.join(root, `.sandbox-denied-${randomUUID()}`);
  let inside: string | undefined;
  let outsideCreated = false;
  try {
    inside = mkdtempSync(path.join(root, 'demo_app', '.sandbox-allowed-'));
    writeFileSync(path.join(inside, 'probe'), 'allowed');
    try {
      writeFileSync(outside, 'must be denied', { flag: 'wx' });
      outsideCreated = true;
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    throw new Error('Droid write sandbox permits writes outside demo_app; refusing SDK initialization');
  } finally {
    if (inside) rmSync(inside, { recursive: true, force: true });
    if (outsideCreated) rmSync(outside, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Locate an executable on PATH (no shell, no spawn). */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        accessSync(candidate, fsConstants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface ProbeReport {
  ok: boolean;
  sdk: boolean;
  droid_cli: boolean;
  detail: string | null;
}

export async function probe(
  loadSdk: () => Promise<unknown> = () => import('@factory/droid-sdk/node'),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProbeReport> {
  let sdk = false;
  let detail: string | null = null;
  try {
    const mod = (await loadSdk()) as Record<string, unknown>;
    sdk = typeof mod.createSession === 'function' && typeof mod.AutonomyLevel === 'object';
    if (!sdk) detail = '@factory/droid-sdk/node is missing createSession/AutonomyLevel';
  } catch (error) {
    detail = `cannot load @factory/droid-sdk/node: ${sanitize(errorText(error), 300, env)}`;
  }
  const droidCli = findOnPath('droid', env) !== null;
  if (!droidCli && detail === null) detail = '`droid` CLI not found on PATH (the SDK spawns it)';
  return { ok: sdk && droidCli, sdk, droid_cli: droidCli, detail };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function writeJsonLine(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeDiagnostic(line: string): void {
  process.stderr.write(`[droid-adapter] ${sanitize(line)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--probe')) {
    const report = await probe();
    writeJsonLine(report);
    if (!report.ok && report.detail) writeDiagnostic(report.detail);
    return report.ok ? EXIT_OK : EXIT_SDK_UNAVAILABLE;
  }

  let input: AdapterInput;
  try {
    input = parseInput(await readStdin());
  } catch (error) {
    const text = errorText(error);
    writeDiagnostic(text);
    writeJsonLine({ type: 'result', exit_code: EXIT_BAD_INPUT, session_id: null, summary: sanitize(text), usage: emptyUsage() });
    return EXIT_BAD_INPUT;
  }

  let sdk: typeof import('@factory/droid-sdk/node');
  try {
    verifyWriteSandbox(input.cwd, process.env, process.platform, input.project);
    sdk = await import('@factory/droid-sdk/node');
  } catch (error) {
    const text = `Droid sandbox/SDK initialization failed: ${errorText(error)}`;
    writeDiagnostic(text);
    writeJsonLine({ type: 'result', exit_code: EXIT_SDK_UNAVAILABLE, session_id: null, summary: sanitize(text), usage: emptyUsage() });
    return EXIT_SDK_UNAVAILABLE;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  const createSession: typeof CreateSessionFn = sdk.createSession;
  return runAdapter(input, {
    createSession,
    listModels: sdk.listModels,
    autonomyOff: sdk.AutonomyLevel.Off,
    emit: writeJsonLine,
    diagnostic: writeDiagnostic,
    abortSignal: controller.signal,
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Do not let a lingering SDK handle keep the subprocess alive.
      setTimeout(() => process.exit(code), 2000).unref();
    },
    (error: unknown) => {
      writeDiagnostic(`fatal: ${errorText(error)}`);
      process.exitCode = EXIT_RUN_FAILED;
    },
  );
}
