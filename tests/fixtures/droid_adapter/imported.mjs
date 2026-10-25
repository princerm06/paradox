import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_ID, parseInput, runAdapter, verifyWriteSandbox } from '../../../engine/droid_adapter/dist/adapter.js';

if (process.argv.includes('--probe')) {
  console.log(JSON.stringify({ ok: true, sdk: true, droid_cli: true, detail: 'offline mocked SDK only' }));
} else {
  const input = parseInput(readFileSync(0, 'utf8'));
  assert.equal(process.env.FACTORY_API_KEY, 'offline-imported-sdk-dummy');
  assert.equal(process.env.PARADOX_TOKEN, undefined);
  assert.equal(process.env.PARADOX_SHELL_TOKEN, undefined);
  verifyWriteSandbox(input.cwd, process.env, process.platform, input.project);
  const emit = (message) => console.log(JSON.stringify(message));
  const permission = (filePath) => ({ toolUses: [{ details: { type: 'create', filePath } }],
    options: [{ value: 'proceed_once', label: 'Allow' }, { value: 'cancel', label: 'Deny' }] });
  const exitCode = await runAdapter(input, {
    autonomyOff: 'off',
    emit,
    diagnostic: (message) => console.error(message),
    listModels: async () => [{ id: DEFAULT_MODEL_ID, disabled: false }],
    createSession: async (options) => ({
      id: 'offline-imported-sdk-session',
      settings: { modelId: options.modelId, autonomyLevel: 'off', toolExecutionMode: 'direct_only' },
      updateSettings: async (settings) => {
        assert.deepEqual(settings.enabledToolIds, ['Read', 'Edit', 'Create']);
        assert.ok(settings.disabledToolIds.includes('Execute'));
        assert.ok(settings.disabledToolIds.includes('Script'));
        assert.ok(settings.disabledToolIds.includes('WaitForScript'));
        assert.ok(settings.disabledToolIds.includes('ToolSearch'));
      },
      listTools: async () => ['Read', 'Edit', 'Create'].map((id) => ({ id, allowed: true, defaultAllowed: false })),
      async *stream(prompt) {
        assert.equal(options.autonomyLevel, 'off');
        assert.deepEqual(options.mcpServers, []);
        assert.equal(await options.permissionHandler(permission('requirements.txt')), 'cancel');
        assert.equal(await options.permissionHandler(permission('tests/test_notes.py')), 'cancel');
        assert.equal(await options.permissionHandler(permission('../state/escape')), 'cancel');
        assert.throws(() => writeFileSync(path.join(input.cwd, 'requirements.txt'), 'tampered'), /EPERM|EACCES/);
        assert.throws(() => writeFileSync(path.join(input.cwd, '../sdk-escape'), 'tampered'), /EPERM|EACCES/);
        emit({ type: 'log', message: 'offline SDK: protected writes denied by handler and kernel' });
        if (prompt.includes('[slow]')) {
          emit({ type: 'log', message: 'offline SDK: waiting for cancellation' });
          await new Promise((resolve) => setTimeout(resolve, 120000));
        }
        if (prompt.includes('[sdk-error]')) throw new Error('offline simulated SDK failure');
        if (prompt.includes('[denied]')) {
          yield { type: 'result', success: false, sessionId: this.id, error: { message: 'offline permission denied' } };
          return;
        }
        if (!prompt.includes('[no-edit]')) {
          assert.equal(await options.permissionHandler(permission('notes_app/ranking.py')), 'proceed_once');
          const ranking = prompt.includes('[compile-error]') ? 'def invalid(:\n' :
            'ORDERING = "priority"\n\ndef rank(notes):\n    return sorted(notes, key=lambda note: (note["priority"], note["id"]), reverse=True)\n';
          writeFileSync(path.join(input.cwd, 'notes_app/ranking.py'), ranking);
          assert.equal(await options.permissionHandler(permission('tests/test_generated_ai.py')), 'proceed_once');
          const test = prompt.includes('[test-error]') ? 'def test_generated_failure():\n    assert False, "offline generated failure"\n' :
            'def test_generated_ai_priority(client):\n    import os\n    assert not any(os.environ.get(name) for name in ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN"))\n    result = client.get("/api/notes").json()\n    assert result["ordering"] == "priority"\n    assert [note["priority"] for note in result["notes"]] == [8, 1]\n';
          writeFileSync(path.join(input.cwd, 'tests/test_generated_ai.py'), test);
        }
        yield { type: 'result', success: true, sessionId: this.id, text: 'Offline mocked open-ended implementation', tokenUsage: null };
      },
      close: async () => emit({ type: 'log', message: 'offline SDK: session closed' }),
    }),
  });
  process.exitCode = exitCode;
}
