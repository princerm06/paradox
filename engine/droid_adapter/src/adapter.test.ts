import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  type AdapterMessage,
  DISABLED_TOOL_IDS,
  DEFAULT_MODEL_ID,
  EXIT_BAD_INPUT,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_RUN_FAILED,
  type PermissionRequest,
  type ProjectPolicy,
  type RunnerDeps,
  decidePermission,
  decideProjectPermission,
  isEditablePath,
  parseInput,
  parseProjectPolicy,
  probe,
  runAdapter,
  sanitize,
  verifyWriteSandbox,
} from './adapter.js';

const workspace = mkdtempSync(path.join(tmpdir(), 'droid-adapter-test-'));
const root = path.join(workspace, 'code');
mkdirSync(path.join(root, 'demo_app'), { recursive: true });
mkdirSync(path.join(workspace, 'outside'));
symlinkSync(path.join(workspace, 'outside'), path.join(root, 'escape'));
symlinkSync(path.join(workspace, 'outside'), path.join(root, 'demo_app', 'escape'));
after(() => rmSync(workspace, { recursive: true, force: true }));

const OFFERED = [
  { value: 'proceed_once', label: 'Yes' },
  { value: 'cancel', label: 'No' },
];

function request(...toolUses: PermissionRequest['toolUses']): PermissionRequest {
  return { toolUses, options: OFFERED };
}

describe('isEditablePath', () => {
  it('accepts relative and absolute paths inside the root', () => {
    assert.equal(isEditablePath(root, 'demo_app/app.py'), true);
    assert.equal(isEditablePath(root, path.join(root, 'demo_app', 'new', 'file.py')), true);
  });

  it('rejects traversal, symlink escapes, the root itself, and forbidden segments', () => {
    assert.equal(isEditablePath(root, '../outside/x.py'), false);
    assert.equal(isEditablePath(root, '/etc/passwd'), false);
    assert.equal(isEditablePath(root, 'escape/x.py'), false);
    assert.equal(isEditablePath(root, '.'), false);
    assert.equal(isEditablePath(root, '.git/config'), false);
    assert.equal(isEditablePath(root, 'demo_app/node_modules/x.js'), false);
    assert.equal(isEditablePath(root, ''), false);
    assert.equal(isEditablePath(root, 42), false);
  });
});

describe('decidePermission', () => {
  it('enforces the production demo_app write root for all requested path forms', () => {
    const writeRoot = path.join(root, 'demo_app');
    for (const filePath of ['demo_app/new.py', path.join(writeRoot, 'new.py')]) {
      assert.equal(decidePermission(root, request({ details: { type: 'create', filePath } }), writeRoot).outcome, 'proceed_once', filePath);
    }
    for (const filePath of ['README.md', 'engine/x.py', 'demo_app/../x.py', '../../etc/hosts', '/etc/passwd', 'demo_app/escape/x.py', 'demo_app/node_modules/x.js', 'demo_app']) {
      assert.equal(decidePermission(root, request({ details: { type: 'edit', filePath } }), writeRoot).outcome, 'cancel', filePath);
    }
    assert.equal(decidePermission(root, request({ details: { type: 'apply_patch', files: [{ filePath: 'demo_app/x.py', moveTo: 'outside.py' }] } }), writeRoot).outcome, 'cancel');
    for (const type of ['exec', 'script']) {
      assert.equal(decidePermission(root, request({ details: { type, filePath: 'demo_app/x.py' } }), writeRoot).outcome, 'cancel');
    }
  });

  it('approves scoped edit/create/apply_patch', () => {
    const decision = decidePermission(
      root,
      request(
        { toolUse: { name: 'Edit' }, details: { type: 'edit', filePath: 'demo_app/a.py' } },
        { toolUse: { name: 'Create' }, details: { type: 'create', filePath: path.join(root, 'demo_app/b.py') } },
        {
          toolUse: { name: 'ApplyPatch' },
          details: { type: 'apply_patch', filePath: 'demo_app/c.py', files: [{ filePath: 'demo_app/c.py', moveTo: 'demo_app/d.py' }] },
        },
      ),
    );
    assert.equal(decision.outcome, 'proceed_once');
  });

  it('denies shell, MCP, sandbox and unknown confirmation types', () => {
    for (const type of ['exec', 'mcp_tool', 'sandbox_violation', 'script', 'ask_user', 'droid_shield_violation', undefined]) {
      const decision = decidePermission(root, request({ toolUse: { name: 'X' }, details: { type } }));
      assert.equal(decision.outcome, 'cancel', `type ${String(type)}`);
    }
  });

  it('denies the whole batch when any edit escapes the root', () => {
    const decision = decidePermission(
      root,
      request(
        { details: { type: 'edit', filePath: 'demo_app/a.py' } },
        { details: { type: 'apply_patch', filePath: 'demo_app/a.py', files: [{ filePath: 'demo_app/a.py', moveTo: '../outside/a.py' }] } },
      ),
    );
    assert.equal(decision.outcome, 'cancel');
  });

  it('cancels when proceed_once is not offered or the batch is empty', () => {
    assert.equal(
      decidePermission(root, { toolUses: [{ details: { type: 'edit', filePath: 'a.py' } }], options: [{ value: 'cancel' }] }).outcome,
      'cancel',
    );
    assert.equal(decidePermission(root, request()).outcome, 'cancel');
  });
});

describe('sanitize', () => {
  it('redacts the live key and key-like tokens', () => {
    const env = { FACTORY_API_KEY: 'fk-live-secret-value-123' };
    const out = sanitize('key fk-live-secret-value-123 and api_key=abc123 Authorization: Bearer xyz', 2000, env);
    assert.ok(!out.includes('fk-live-secret-value-123'));
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('xyz'));
  });

  it('truncates long output', () => {
    assert.ok(sanitize('a'.repeat(50), 10, {}).endsWith('[truncated]'));
  });
});

describe('parseInput', () => {
  it('accepts a valid object and canonicalizes cwd', () => {
    const input = parseInput(JSON.stringify({ cwd: root, prompt: 'fix it' }));
    assert.equal(input.prompt, 'fix it');
    assert.ok(path.isAbsolute(input.cwd));
  });

  it('rejects malformed input', () => {
    assert.throws(() => parseInput('nope'));
    assert.throws(() => parseInput('[]'));
    assert.throws(() => parseInput(JSON.stringify({ cwd: 'relative', prompt: 'x' })));
    assert.throws(() => parseInput(JSON.stringify({ cwd: root, prompt: '  ' })));
    assert.throws(() => parseInput(JSON.stringify({ cwd: path.join(root, 'missing'), prompt: 'x' })));
  });
});

type FakeSession = Awaited<ReturnType<RunnerDeps['createSession']>>;

function harness(streamMessages: Array<Record<string, unknown>>, options: { throwOnCreate?: Error } = {}) {
  const emitted: AdapterMessage[] = [];
  const diagnostics: string[] = [];
  const captured: { options?: Parameters<RunnerDeps['createSession']>[0]; update?: unknown; closed: boolean } = { closed: false };
  const deps: RunnerDeps = {
    autonomyOff: 'off' as RunnerDeps['autonomyOff'],
    env: { FACTORY_API_KEY: 'fk-test-key-0000000000' },
    emit: (message) => emitted.push(message),
    diagnostic: (line) => diagnostics.push(line),
    listModels: async () => [DEFAULT_MODEL_ID, 'gpt-6.1-sol'].map((id) => ({ id, disabled: false })) as Awaited<ReturnType<RunnerDeps['listModels']>>,
    createSession: async (sessionOptions) => {
      captured.options = sessionOptions;
      if (options.throwOnCreate) throw options.throwOnCreate;
      const session = {
        id: 'sess-1',
        settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
        async listTools() {
          return [{ id: 'Read', allowed: true }, { id: 'Create', allowed: true }, { id: 'Edit', allowed: true }];
        },
        async *stream() {
          for (const message of streamMessages) yield message;
        },
        async updateSettings(options: Parameters<FakeSession['updateSettings']>[0]) { captured.update = options; },
        async close() {
          captured.closed = true;
        },
      };
      return session as unknown as FakeSession;
    },
  };
  return { deps, emitted, diagnostics, captured };
}

describe('runAdapter', () => {
  const input = { cwd: root, prompt: 'Fix the bug in demo_app' };

  it('never disables the registered write tools required for approval', () => {
    assert.ok(!DISABLED_TOOL_IDS.includes('Edit'));
    assert.ok(!DISABLED_TOOL_IDS.includes('Create'));
    for (const id of ['Execute', 'Script', 'WaitForScript']) assert.ok(DISABLED_TOOL_IDS.includes(id));
  });

  it('configures the SDK session with edit-only restrictions', async () => {
    const h = harness([{ type: 'result', success: true, sessionId: 'sess-1', text: 'done', tokenUsage: null }]);
    await runAdapter(input, h.deps);
    const opts = h.captured.options!;
    assert.equal(opts.cwd, root);
    assert.equal(opts.modelId, DEFAULT_MODEL_ID);
    assert.equal(opts.autonomyLevel, 'off');
    assert.equal(opts.autoRejectPermissionRequests, false);
    assert.equal(opts.askUserHandler, undefined);
    for (const id of ['Execute', 'Script', 'WaitForScript', 'WebSearch', 'FetchUrl', 'Task', 'SpawnAgent']) {
      assert.ok(opts.disabledToolIds?.includes(id), id);
    }
    assert.deepEqual(opts.disabledToolIds, [...DISABLED_TOOL_IDS]);
    assert.deepEqual(h.captured.update, { enabledToolIds: ['Read', 'Edit', 'Create'], disabledToolIds: [...DISABLED_TOOL_IDS] });
    const handler = opts.permissionHandler!;
    assert.equal(await handler({ toolUses: [{ details: { type: 'exec', command: 'rm -rf /' } }], options: OFFERED } as never), 'cancel');
    assert.equal(
      await handler({ toolUses: [{ details: { type: 'edit', filePath: 'demo_app/x.py' } }], options: OFFERED } as never),
      'proceed_once',
    );
    for (const filePath of ['outside.py', '../demo_app/escape.py', path.join(root, 'outside.py')]) {
      assert.equal(await handler({ toolUses: [{ details: { type: 'edit', filePath } }], options: OFFERED } as never), 'cancel');
    }
    assert.equal(await handler({ toolUses: [{ details: { type: 'apply_patch', files: [{ filePath: 'demo_app/x.py' }] } }], options: OFFERED } as never), 'proceed_once');
    assert.equal(h.captured.closed, true);
  });

  it('streams logs then a successful result with usage', async () => {
    const h = harness([
      { type: 'assistant', text: 'Looking at the file' },
      { type: 'tool_call', name: 'Edit', toolUseId: 't1', input: {} },
      { type: 'tool_result', toolName: 'Edit', toolUseId: 't1', content: 'ok', isError: false },
      { type: 'working_state_changed', state: 'idle' },
      {
        type: 'result',
        success: true,
        interrupted: false,
        subtype: 'success',
        sessionId: 'sess-1',
        text: 'Fixed the off-by-one.',
        tokenUsage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, factoryCredits: 0.5 },
      },
    ]);
    const code = await runAdapter(input, h.deps);
    assert.equal(code, EXIT_OK);
    const logs = h.emitted.filter((m) => m.type === 'log').map((m) => (m as { message: string }).message);
    assert.ok(logs.includes('assistant: Looking at the file'));
    assert.ok(logs.includes('tool_call: Edit'));
    assert.ok(logs.includes('tool_result: Edit'));
    const result = h.emitted.at(-1);
    assert.deepEqual(result, {
      type: 'result',
      exit_code: 0,
      session_id: 'sess-1',
      summary: 'Fixed the off-by-one.',
      usage: { input_tokens: 120, output_tokens: 30, factory_credits: 0.5 },
    });
    assert.equal(h.emitted.filter((m) => m.type === 'result').length, 1);
  });

  it('reports a failed turn with nullable usage', async () => {
    const h = harness([
      { type: 'result', success: false, interrupted: false, subtype: 'error_during_execution', sessionId: 'sess-1', text: '', tokenUsage: null, error: { message: 'model error' } },
    ]);
    const code = await runAdapter(input, h.deps);
    assert.equal(code, EXIT_RUN_FAILED);
    assert.deepEqual(h.emitted.at(-1), {
      type: 'result',
      exit_code: 1,
      session_id: 'sess-1',
      summary: 'model error',
      usage: { input_tokens: null, output_tokens: null, factory_credits: null },
    });
  });

  it('fails without FACTORY_API_KEY and never creates a session', async () => {
    const h = harness([]);
    h.deps.env = {};
    const code = await runAdapter(input, h.deps);
    assert.equal(code, EXIT_BAD_INPUT);
    assert.equal(h.captured.options, undefined);
  });

  it('sanitizes SDK errors', async () => {
    const h = harness([], { throwOnCreate: new Error('spawn failed for key fk-test-key-0000000000') });
    const code = await runAdapter(input, h.deps);
    assert.equal(code, EXIT_RUN_FAILED);
    const result = h.emitted.at(-1) as { summary: string; session_id: string | null };
    assert.equal(result.session_id, null);
    assert.ok(!result.summary.includes('fk-test-key'));
    assert.ok(h.diagnostics.every((line) => !line.includes('fk-test-key')));
  });

  it('reports cancellation and closes an established SDK session', async () => {
    const h = harness([]);
    const controller = new AbortController();
    h.deps.abortSignal = controller.signal;
    h.deps.createSession = async () => ({
      id: 'cancelled-session',
      settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
      async listTools() { return [{ id: 'Read', allowed: true }, { id: 'Edit', allowed: true }, { id: 'Create', allowed: true }]; },
      async *stream() {
        controller.abort();
        throw new Error('operation aborted');
      },
      async updateSettings() {},
      async close() { h.captured.closed = true; },
    } as unknown as FakeSession);
    assert.equal(await runAdapter(input, h.deps), EXIT_INTERRUPTED);
    assert.equal(h.captured.closed, true);
    assert.deepEqual(h.emitted.at(-1), {
      type: 'result', exit_code: 130, session_id: 'cancelled-session',
      summary: 'Droid run aborted', usage: { input_tokens: null, output_tokens: null, factory_credits: null },
    });
  });

  it('fails closed if the SDK stream ends without a result', async () => {
    const h = harness([{ type: 'assistant', text: 'partial work' }]);
    assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
    assert.equal(h.captured.closed, true);
    assert.equal(h.emitted.filter((message) => message.type === 'result').length, 1);
    assert.equal((h.emitted.at(-1) as { summary: string }).summary, 'Droid stream ended without a result');
  });

  it('rejects the saved script-only failure before spending a model turn', async () => {
    const h = harness([]);
    let streamed = false;
    h.deps.env!.PARADOX_DROID_MODEL = 'gpt-6.1-sol';
    h.deps.createSession = async (options) => {
      h.captured.options = options;
      return {
        id: 'script-only-session',
        settings: { autonomyLevel: 'off', modelId: 'gpt-6.1-sol', toolExecutionMode: 'script_only' },
        async listTools() { throw new Error('must reject mode first'); },
        async *stream() { streamed = true; },
        async updateSettings() { assert.fail('must reject mode before configuration'); },
        async close() { h.captured.closed = true; },
      } as unknown as FakeSession;
    };
    assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
    assert.equal(h.captured.options!.modelId, 'gpt-6.1-sol');
    assert.ok(h.captured.options!.disabledToolIds!.includes('Script'));
    assert.equal(streamed, false);
    assert.equal(h.captured.closed, true);
    assert.match((h.emitted.at(-1) as { summary: string }).summary, /direct_only/);
    assert.equal((h.emitted.at(-1) as { usage: { factory_credits: null } }).usage.factory_credits, null);
  });

  it('rejects an empty file-tool catalog before streaming', async () => {
    const h = harness([]);
    let streamed = false;
    h.deps.createSession = async () => ({
      id: 'no-tools-session',
      settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
      async listTools() { return []; },
      async *stream() { streamed = true; },
      async updateSettings() {},
      async close() { h.captured.closed = true; },
    } as unknown as FakeSession);
    assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
    assert.equal(streamed, false);
    assert.equal(h.captured.closed, true);
    assert.match((h.emitted.at(-1) as { summary: string }).summary, /required file tools/);
  });

  for (const mode of [undefined, 'unexpected']) {
    it(`rejects unknown execution mode ${String(mode)} and closes without a turn`, async () => {
      const h = harness([]);
      h.deps.createSession = async () => ({
        id: 'unknown-mode',
        settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: mode },
        async listTools() { assert.fail('must reject mode first'); },
        async *stream() { assert.fail('must not spend a turn'); },
        async updateSettings() {},
        async close() { h.captured.closed = true; },
      } as unknown as FakeSession);
      assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
      assert.equal(h.captured.closed, true);
      assert.match((h.emitted.at(-1) as { summary: string }).summary, /toolExecutionMode.*direct_only/);
      assert.equal((h.emitted.at(-1) as { usage: { factory_credits: null } }).usage.factory_credits, null);
    });
  }

  for (const disabled of [false, true]) {
    it(`rejects ${disabled ? 'organization-disabled' : 'unavailable'} pinned model before session creation`, async () => {
      const h = harness([]);
      h.deps.listModels = async () => (disabled
        ? [{ id: DEFAULT_MODEL_ID, disabled: true, disabledReason: 'organization policy' }]
        : []) as Awaited<ReturnType<RunnerDeps['listModels']>>;
      assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
      assert.equal(h.captured.options, undefined);
      const result = h.emitted.at(-1) as { summary: string };
      assert.ok(result.summary.includes(DEFAULT_MODEL_ID));
      assert.match(result.summary, disabled ? /organization policy/ : /unavailable/);
    });
  }

  for (const missing of ['Read', 'Edit', 'Create']) {
    it(`rejects missing ${missing} before streaming and closes the session`, async () => {
      const h = harness([]);
      h.deps.createSession = async () => ({
        id: 'blocked-tool',
        settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
        async listTools() { return ['Read', 'Edit', 'Create'].filter((id) => id !== missing).map((id) => ({ id, allowed: true })); },
        async *stream() { assert.fail('must not spend a turn'); },
        async updateSettings() {},
        async close() { h.captured.closed = true; },
      } as unknown as FakeSession);
      assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
      assert.equal(h.captured.closed, true);
      assert.ok((h.emitted.at(-1) as { summary: string }).summary.includes(missing));
    });
  }

  for (const blocked of ['Read', 'Edit', 'Create']) {
    it(`rejects a registered but disallowed ${blocked} before streaming`, async () => {
      const h = harness([]);
      h.deps.createSession = async () => ({
        id: 'read-blocked',
        settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
        async listTools() { return ['Read', 'Edit', 'Create'].map((id) => ({ id, allowed: id !== blocked })); },
        async *stream() { assert.fail('must not spend a turn'); },
        async updateSettings() {},
        async close() { h.captured.closed = true; },
      } as unknown as FakeSession);
      assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
      assert.equal(h.captured.closed, true);
      assert.match((h.emitted.at(-1) as { summary: string }).summary, /must each report allowed=true/);
    });
  }

  for (const allowed of [true, false]) {
    it(`${allowed ? 'streams' : 'rejects run-2 catalog'} with Edit/Create allowed=${allowed} and logs both metadata flags`, async () => {
      const h = harness([]);
      let streamed = false;
      h.deps.createSession = async () => ({
        id: 'registered-tools',
        settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
        async listTools() { return ['Read', 'Edit', 'Create'].map((id) => ({ id, allowed: id === 'Read' || allowed, defaultAllowed: id === 'Read' })); },
        async *stream() {
          streamed = true;
          yield { type: 'result', success: true, sessionId: 'registered-tools', text: 'done' };
        },
        async updateSettings() {},
        async close() { h.captured.closed = true; },
      } as unknown as FakeSession);
      assert.equal(await runAdapter(input, h.deps), allowed ? EXIT_OK : EXIT_RUN_FAILED);
      assert.equal(streamed, allowed);
      assert.equal(h.captured.closed, true);
      if (!allowed) assert.equal((h.emitted.at(-1) as { usage: { factory_credits: null } }).usage.factory_credits, null);
      const logs = h.emitted.filter((message) => message.type === 'log').map((message) => message.message).join('\n');
      for (const id of ['Edit', 'Create']) assert.ok(logs.includes(`${id} (allowed=${allowed}, defaultAllowed=false)`));
      assert.ok(logs.includes('Read (allowed=true, defaultAllowed=true)'));
    });
  }

  it('checks model and tool metadata before streaming with no alternate model', async () => {
    const h = harness([]);
    const calls: string[] = [];
    h.deps.listModels = async (options) => {
      calls.push('models');
      assert.equal(options?.includeDisabled, true);
      assert.equal(options?.cwd, root);
      return [{ id: DEFAULT_MODEL_ID, disabled: false }] as Awaited<ReturnType<RunnerDeps['listModels']>>;
    };
    h.deps.createSession = async (options) => {
      calls.push('create');
      assert.equal(options.modelId, DEFAULT_MODEL_ID);
      return {
        id: 'direct-tools',
        settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
        async listTools(options: { toolIds: string[] }) {
          calls.push('tools');
          assert.deepEqual(options.toolIds, ['Read', 'Edit', 'Create']);
          return options.toolIds.map((id) => ({ id, allowed: true }));
        },
        async *stream() {
          calls.push('stream');
          yield { type: 'result', success: true, sessionId: 'direct-tools', text: 'done' };
        },
        async updateSettings() { calls.push('update'); },
        async close() { calls.push('close'); },
      } as unknown as FakeSession;
    };
    assert.equal(await runAdapter(input, h.deps), EXIT_OK);
    assert.deepEqual(calls, ['models', 'create', 'update', 'tools', 'stream', 'close']);
  });

  it('reports model discovery errors without creating a session', async () => {
    const h = harness([]);
    h.deps.listModels = async () => { throw new Error('metadata unavailable'); };
    assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
    assert.equal(h.captured.options, undefined);
    assert.match((h.emitted.at(-1) as { summary: string }).summary, /claude-sonnet-4-6.*metadata unavailable/);
  });

  it('enables only the approved wire tool IDs before checking actual availability', async () => {
    const h = harness([]);
    let configured = false;
    h.deps.createSession = async (options) => ({
      id: 'explicit-enable',
      settings: { autonomyLevel: 'off', modelId: options.modelId, toolExecutionMode: 'direct_only' },
      async updateSettings(overrides: unknown) {
        assert.deepEqual(overrides, { enabledToolIds: ['Read', 'Edit', 'Create'], disabledToolIds: [...DISABLED_TOOL_IDS] });
        configured = true;
      },
      async listTools(params: unknown) {
        assert.equal(configured, true);
        assert.deepEqual(params, { toolIds: ['Read', 'Edit', 'Create'] });
        return ['Read', 'Edit', 'Create'].map((id) => ({ id, allowed: id === 'Read' || configured }));
      },
      async *stream() { yield { type: 'result', success: true, sessionId: 'explicit-enable', text: 'done' }; },
      async close() { h.captured.closed = true; },
    } as unknown as FakeSession);
    assert.equal(await runAdapter(input, h.deps), EXIT_OK);
    assert.equal(h.captured.closed, true);
    assert.ok(h.emitted.some((message) => message.type === 'log' && message.message === 'permission handler audit: invoked=0'));
  });

  for (const changed of ['autonomyLevel', 'toolExecutionMode', 'modelId', 'update-error']) {
    it(`fails closed on post-configuration ${changed} without streaming or escalation`, async () => {
      const h = harness([]);
      const settings: Record<string, string> = { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' };
      h.deps.createSession = async () => ({
        id: 'configuration-failed', settings,
        async updateSettings() {
          if (changed === 'update-error') throw new Error('wire update rejected');
          settings[changed] = { autonomyLevel: 'low', toolExecutionMode: 'script_only', modelId: 'other-model' }[changed]!;
        },
        async listTools() { assert.fail('must reject settings first'); },
        async *stream() { assert.fail('must not start a model turn'); },
        async close() { h.captured.closed = true; },
      } as unknown as FakeSession);
      assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
      assert.equal(h.captured.closed, true);
      assert.equal((h.emitted.at(-1) as { usage: { factory_credits: null } }).usage.factory_credits, null);
    });
  }

  it('rejects effective model substitution before streaming', async () => {
    const h = harness([]);
    h.deps.createSession = async () => ({
      id: 'wrong-model',
      settings: { autonomyLevel: 'off', modelId: 'other-model', toolExecutionMode: 'direct_only' },
      async listTools() { assert.fail('must reject model first'); },
      async *stream() { assert.fail('must not spend a turn'); },
      async updateSettings() {},
      async close() { h.captured.closed = true; },
    } as unknown as FakeSession);
    assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
    assert.equal(h.captured.closed, true);
    assert.match((h.emitted.at(-1) as { summary: string }).summary, /refusing a silent model substitution/);
  });

  it('closes the initialized session if tool metadata fails', async () => {
    const h = harness([]);
    h.deps.createSession = async () => ({
      id: 'tool-error',
      settings: { autonomyLevel: 'off', modelId: DEFAULT_MODEL_ID, toolExecutionMode: 'direct_only' },
      async listTools() { throw new Error('tool metadata unavailable'); },
      async *stream() { assert.fail('must not spend a turn'); },
      async updateSettings() {},
      async close() { h.captured.closed = true; },
    } as unknown as FakeSession);
    assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
    assert.equal(h.captured.closed, true);
    assert.match((h.emitted.at(-1) as { summary: string }).summary, /Cannot verify direct file tools.*tool metadata unavailable/);
  });

  it('keeps direct writes approval-gated with Off instead of enabling Script', async () => {
    const h = harness([{ type: 'result', success: true, sessionId: 'sess-1', text: 'edited' }]);
    assert.equal(await runAdapter(input, h.deps), EXIT_OK);
    const options = h.captured.options!;
    assert.equal(options.autonomyLevel, 'off');
    assert.ok(options.disabledToolIds!.includes('Script'));
    assert.ok(options.disabledToolIds!.includes('Execute'));
    assert.ok(options.disabledToolIds!.includes('WaitForScript'));
    assert.ok(!options.disabledToolIds!.includes('Read'));
    assert.ok(!options.disabledToolIds!.includes('Create'));
    assert.ok(!options.disabledToolIds!.includes('Edit'));
    assert.equal(await options.permissionHandler!(request({ details: { type: 'create', filePath: 'demo_app/new.py' } }) as never), 'proceed_once');
  });

  it('allows a mocked SDK direct-file edit through the permission handler with Off', async () => {
    const h = harness([]);
    const target = path.join(root, 'demo_app', 'mock_generated.py');
    h.deps.createSession = async (options) => ({
      id: 'direct-edit-session',
      settings: { autonomyLevel: 'off', modelId: options.modelId, toolExecutionMode: 'direct_only' },
      async listTools() { return [{ id: 'Read', allowed: true }, { id: 'Create', allowed: true }, { id: 'Edit', allowed: true }]; },
      async *stream() {
        assert.equal(options.autonomyLevel, 'off');
        assert.equal(await options.permissionHandler!(request({ details: { type: 'create', filePath: target } }) as never), 'proceed_once');
        writeFileSync(target, 'ORDERING = "popular"\n');
        yield { type: 'result', success: true, sessionId: 'direct-edit-session', text: 'mock edit applied' };
      },
      async updateSettings() {},
      async close() { h.captured.closed = true; },
    } as unknown as FakeSession);
    assert.equal(await runAdapter(input, h.deps), EXIT_OK);
    assert.equal(readFileSync(target, 'utf8'), 'ORDERING = "popular"\n');
    assert.equal(h.captured.closed, true);
    assert.ok(h.emitted.some((message) => message.type === 'log' && message.message.includes('permission proceed_once')));
    assert.ok(h.emitted.some((message) => message.type === 'log' && message.message === 'permission handler audit: invoked=1'));
    rmSync(target);
  });
});

describe('imported-project policy', () => {
  const imported = path.join(workspace, 'imported-code');
  mkdirSync(path.join(imported, 'notes_app'), { recursive: true });
  mkdirSync(path.join(imported, 'tests'), { recursive: true });
  writeFileSync(path.join(imported, 'requirements.txt'), 'fastapi\n');
  writeFileSync(path.join(imported, 'tests', 'test_original.py'), 'def test_original(): pass\n');
  symlinkSync(path.join(workspace, 'outside'), path.join(imported, 'escape'));
  symlinkSync(path.join(imported, 'requirements.txt'), path.join(imported, 'manifest-alias'));
  const policy: ProjectPolicy = {
    adapter: 'fastapi-sqlite-v1', editable_prefixes: [''],
    immutable_paths: ['requirements*.txt', 'pyproject.toml', 'Pipfile*'],
    protected_files: ['requirements.txt', 'tests/test_original.py'],
  };
  const input = { cwd: imported, prompt: 'Add a custom notes capability and a test', project: policy };

  it('parses only the agreed bounded internal policy', () => {
    assert.deepEqual(parseInput(JSON.stringify(input)), { ...input, cwd: realpathSync(imported) });
    for (const invalid of [null, {}, { ...policy, adapter: 'node' }, { ...policy, shell: true },
      { ...policy, protected_files: ['../source.py'] }, { ...policy, protected_files: ['/etc/passwd'] },
      { ...policy, editable_prefixes: [] }, { ...policy, immutable_paths: ['requirements?.txt'] }]) {
      assert.throws(() => parseProjectPolicy(invalid));
    }
  });

  for (const target of ['notes_app/new.py', 'tests/test_new.py', path.join(imported, 'notes_app/absolute.py')]) {
    it('allows an isolated editable file: ' + path.basename(target), () => {
      assert.equal(decideProjectPermission(imported, request({ details: { type: 'create', filePath: target } }), policy).outcome, 'proceed_once');
    });
  }

  for (const target of ['../source.py', '/etc/passwd', 'escape/x.py', 'manifest-alias', 'notes_app/../x.py',
    'requirements.txt', 'nested/requirements-new.txt', 'tests/test_original.py', 'notes_app/conftest.py',
    '.factory/settings.json', 'nested/.claude/hooks.py', '.mcp.json', '.git/config', 'node_modules/x.js', 'AGENTS.md']) {
    it('denies imported protected or escaping path: ' + target, () => {
      assert.equal(decideProjectPermission(imported, request({ details: { type: 'edit', filePath: target } }), policy).outcome, 'cancel');
    });
  }

  it('enforces editable prefixes, all patch destinations and non-file denials', () => {
    assert.equal(decideProjectPermission(imported, request({ details: { type: 'create', filePath: 'README.md' } }),
      { ...policy, editable_prefixes: ['notes_app/'] }).outcome, 'cancel');
    assert.equal(decideProjectPermission(imported, request({ details: { type: 'apply_patch', files: [
      { filePath: 'notes_app/new.py', moveTo: '../source.py' },
    ] } }), policy).outcome, 'cancel');
    for (const type of ['exec', 'script', 'mcp']) {
      assert.equal(decideProjectPermission(imported, request({ details: { type, filePath: 'notes_app/x.py' } }), policy).outcome, 'cancel');
    }
  });

  it('routes real mocked SDK edits through the imported permission handler', async () => {
    const h = harness([]);
    const original = h.deps.createSession;
    h.deps.createSession = async (options) => {
      const session = await original(options);
      return { ...session, async *stream(prompt) {
        assert.equal(prompt, input.prompt);
        assert.equal(await options.permissionHandler!(request({ details: { type: 'create', filePath: 'notes_app/generated.py' } }) as never), 'proceed_once');
        writeFileSync(path.join(imported, 'notes_app/generated.py'), 'VALUE = "open ended request"\n');
        assert.equal(await options.permissionHandler!(request({ details: { type: 'edit', filePath: 'requirements.txt' } }) as never), 'cancel');
        yield { type: 'result', success: true, sessionId: 'sess-imported', text: 'Implemented requested files', tokenUsage: null } as never;
      } };
    };
    assert.equal(await runAdapter(input, h.deps), EXIT_OK);
    assert.match(readFileSync(path.join(imported, 'notes_app/generated.py'), 'utf8'), /open ended/);
    assert.equal(h.captured.options!.cwd, imported);
    assert.equal(h.captured.options!.autonomyLevel, 'off');
    assert.deepEqual(h.captured.options!.mcpServers, []);
    assert.ok(h.captured.options!.disabledToolIds!.includes('ToolSearch'));
    assert.ok(h.emitted.some((message) => message.type === 'log' && message.message === 'permission handler audit: invoked=2'));
    assert.equal(h.captured.closed, true);
  });

  for (const outcome of ['denied', 'interrupted', 'exception']) {
    it('closes the imported SDK session after ' + outcome, async () => {
      const h = harness([]);
      const original = h.deps.createSession;
      h.deps.createSession = async (options) => ({ ...await original(options), async *stream() {
        assert.equal(await options.permissionHandler!(request({ details: { type: 'edit', filePath: 'requirements.txt' } }) as never), 'cancel');
        if (outcome === 'exception') throw new Error('mock transport failed');
        yield { type: 'result', success: false, interrupted: outcome === 'interrupted',
          sessionId: 'sess-imported-failed', error: { message: 'permission denied' } } as never;
      } });
      assert.equal(await runAdapter(input, h.deps), outcome === 'interrupted' ? EXIT_INTERRUPTED : EXIT_RUN_FAILED);
      assert.equal(h.captured.closed, true);
      assert.equal(readFileSync(path.join(imported, 'requirements.txt'), 'utf8'), 'fastapi\n');
      assert.ok(h.emitted.some((message) => message.type === 'log' && message.message === 'permission handler audit: invoked=1'));
    });
  }

  for (const tool of ['Execute', 'Script', 'ToolSearch', 'mcp_unexpected', 'UnknownFutureTool']) {
    it('rejects unexpected allowed tool before streaming: ' + tool, async () => {
      const h = harness([]);
      const original = h.deps.createSession;
      let streamed = false;
      h.deps.createSession = async (options) => ({ ...await original(options),
        async listTools() { return [
          { id: 'Read', allowed: true }, { id: 'Edit', allowed: true }, { id: 'Create', allowed: true },
          { id: tool, allowed: true },
        ] as never; },
        async *stream() { streamed = true; },
      });
      assert.equal(await runAdapter(input, h.deps), EXIT_RUN_FAILED);
      assert.equal(streamed, false);
      assert.equal(h.captured.closed, true);
      assert.ok(h.emitted.some((message) => message.type === 'result' && message.summary?.includes('unexpected allowed tools')));
    });
  }

  it('rejects a forged imported sandbox marker without starting the SDK', () => {
    assert.throws(() => verifyWriteSandbox(imported, {}, 'darwin', policy), /imported-project write sandbox/);
    assert.throws(() => verifyWriteSandbox(imported, { PARADOX_DROID_SANDBOX: 'macos-project-write-v1' }, 'darwin', policy), /permits writes outside future code/);
  });
});

describe('verifyWriteSandbox', () => {
  it('rejects missing sandbox ownership and unsupported platforms', () => {
    assert.throws(() => verifyWriteSandbox(root, {}, 'darwin'), /engine-managed macOS write sandbox/);
    assert.throws(() => verifyWriteSandbox(root, { PARADOX_DROID_SANDBOX: 'macos-write-v1' }, 'linux'), /engine-managed macOS write sandbox/);
  });

  it('rejects a forged marker in an unsandboxed process', () => {
    assert.throws(() => verifyWriteSandbox(root, { PARADOX_DROID_SANDBOX: 'macos-write-v1' }, 'darwin'), /permits writes outside demo_app/);
  });
});

describe('probe', () => {
  it('fails when the SDK cannot load', async () => {
    const report = await probe(async () => {
      throw new Error('Cannot find package');
    }, { PATH: '' });
    assert.equal(report.ok, false);
    assert.equal(report.sdk, false);
  });

  it('fails when droid is not on PATH even if the SDK loads', async () => {
    const report = await probe(async () => ({ createSession() {}, AutonomyLevel: { Off: 'off' } }), { PATH: '' });
    assert.equal(report.sdk, true);
    assert.equal(report.droid_cli, false);
    assert.equal(report.ok, false);
  });
});
