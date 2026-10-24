import path from 'node:path';
import { createSession, ProcessTransport, UpdateSessionSettingsRequestParamsSchema, ListToolsRequestParamsSchema, ToolSelectionOverridesSchema } from '@factory/droid-sdk/node';
import { DISABLED_TOOL_IDS } from '../dist/adapter.js';

if (process.env.FACTORY_API_KEY) throw new Error('Unset FACTORY_API_KEY for offline research');
if (!['off', 'low'].includes(process.argv[2])) throw new Error('Expected off or low');
const cwd = path.resolve(process.argv[3]);
const selection = process.argv[4] ?? 'both';
if (!['both', 'enabled', 'additional', 'none'].includes(selection)) throw new Error('Expected both, enabled, additional or none');
const overrides = {
  ...['both', 'enabled'].includes(selection) ? { enabledToolIds: ['Read', 'Edit', 'Create'] } : {},
  ...['both', 'additional'].includes(selection) ? { additionalToolIds: ['Edit', 'Create'] } : {},
  disabledToolIds: [...DISABLED_TOOL_IDS],
};
for (const [name, schema] of Object.entries({ UpdateSessionSettingsRequestParamsSchema, ListToolsRequestParamsSchema, ToolSelectionOverridesSchema })) {
  console.log(JSON.stringify({ schema: name, parsedOverrides: schema.parse(overrides) }));
}
const extra = process.argv[5] ?? 'none';
if (!['none', 'add', 'only'].includes(extra)) throw new Error('Expected none, add or only');
const transport = new ProcessTransport({
  cwd,
  ...extra === 'none' ? {} : { droidExecExtraArgs: [extra === 'add' ? '--add-tools' : '--only-tools', 'Read,Edit,Create'] },
});
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 12000);
let session;
let permissionRequests = 0;
try {
  await transport.connect();
  session = await createSession({
    transport,
    cwd,
    modelId: 'claude-sonnet-4-6',
    autonomyLevel: process.argv[2],
    disabledToolIds: [...DISABLED_TOOL_IDS],
    autoRejectPermissionRequests: false,
    disableBuiltinSkills: true,
    abortSignal: abort.signal,
    permissionHandler: () => { permissionRequests += 1; return 'cancel'; },
  });
  console.log(JSON.stringify({ phase: 'initialized', settings: session.settings }));
  const catalog = async (phase, params) => console.log(JSON.stringify({ phase, tools: await session.listTools(params) }));
  await catalog('actual', {});
  await catalog('list-overrides-before-update', overrides);
  await catalog('actual-after-list', {});
  await session.updateSettings(overrides);
  console.log(JSON.stringify({ phase: 'after-update', settings: session.settings }));
  await catalog('after-update', {});
  await catalog('list-overrides', overrides);
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (session) await session.close();
  else await transport.close();
  console.log(JSON.stringify({ permissionRequests, modelTurns: 0 }));
}
