import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  type AdapterMessage,
  DISABLED_TOOL_IDS,
  EXIT_BAD_INPUT,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_RUN_FAILED,
  type PermissionRequest,
  type RunnerDeps,
  decidePermission,
  isEditablePath,
  parseInput,
  probe,
  runAdapter,
  sanitize,
} from './adapter.js';

const workspace = mkdtempSync(path.join(tmpdir(), 'droid-adapter-test-'));
const root = path.join(workspace, 'code');
mkdirSync(path.join(root, 'demo_app'), { recursive: true });
mkdirSync(path.join(workspace, 'outside'));
symlinkSync(path.join(workspace, 'outside'), path.join(root, 'escape'));
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
  const captured: { options?: Parameters<RunnerDeps['createSession']>[0]; closed: boolean } = { closed: false };
  const deps: RunnerDeps = {
    autonomyOff: 'off' as RunnerDeps['autonomyOff'],
    env: { FACTORY_API_KEY: 'fk-test-key-0000000000' },
    emit: (message) => emitted.push(message),
    diagnostic: (line) => diagnostics.push(line),
    createSession: async (sessionOptions) => {
      captured.options = sessionOptions;
      if (options.throwOnCreate) throw options.throwOnCreate;
      const session = {
        id: 'sess-1',
        async *stream() {
          for (const message of streamMessages) yield message;
        },
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

  it('configures the SDK session with edit-only restrictions', async () => {
    const h = harness([{ type: 'result', success: true, sessionId: 'sess-1', text: 'done', tokenUsage: null }]);
    await runAdapter(input, h.deps);
    const opts = h.captured.options!;
    assert.equal(opts.cwd, root);
    assert.equal(opts.autonomyLevel, 'off');
    assert.equal(opts.autoRejectPermissionRequests, false);
    assert.equal(opts.askUserHandler, undefined);
    for (const id of ['Execute', 'Script', 'WebSearch', 'FetchUrl', 'Task', 'SpawnAgent']) {
      assert.ok(opts.disabledToolIds?.includes(id), id);
    }
    assert.deepEqual(opts.disabledToolIds, [...DISABLED_TOOL_IDS]);
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
      async *stream() {
        controller.abort();
        throw new Error('operation aborted');
      },
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
