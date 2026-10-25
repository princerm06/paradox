import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.PARADOX_PRIMARY_OUTPUT || readFileSync(join(repo, '.primary-demo-output'), 'utf8').trim();
const require = createRequire(join(repo, 'apps/studio/package.json'));
const { chromium, expect } = require('@playwright/test');
const recording = process.argv.includes('--record');
const enginePort = Number(process.env.PARADOX_PRIMARY_ENGINE_PORT || 8056);
const studioPort = Number(process.env.PARADOX_PRIMARY_STUDIO_PORT || 5216);
const engine = `http://127.0.0.1:${enginePort}`;
const studio = `http://127.0.0.1:${studioPort}`;
if (![enginePort, studioPort].every(port => port > 1024 && port < 65536 && ![8000, 8001, 5173, 5176, 8012, 8040, 5204].includes(port)) || enginePort === studioPort) throw Error('Unsafe recording ports');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, recording ? 'take-' : 'rehearsal-'));
mkdirSync(join(root, 'home'));
mkdirSync(join(root, 'shots'));
const audit = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), recording, engine, studio, root, scenes: [], clicks: [], generations: {}, evaluations: {}, milestones: [], mutations: [], violations: [], errors: [] };
const children = [];
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
let browser;
let context;
let page;
let clock = 0;
const second = () => clock ? (performance.now() - clock) / 1000 : 0;
const save = () => writeFileSync(join(root, 'verification.json'), JSON.stringify(audit, null, 2));

async function free(port) {
  await new Promise((resolveFree, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => listener.close(resolveFree));
  });
}
function start(command, args, cwd, env, name) {
  const log = createWriteStream(join(root, `${name}.log`));
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.push(child);
  return child;
}
async function request(path, method = 'GET', body) {
  const response = await fetch(engine + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function waitUrl(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(250);
  }
  throw Error(`Service did not start: ${url}`);
}
async function pause(seconds) { if (recording) await sleep(seconds * 1000); }
async function click(locator, mark = true) {
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  if (mark && clock && box) {
    await pause(0.25);
    audit.clicks.push({ second: second(), label: (await locator.innerText()).slice(0, 100), x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height });
  }
  await locator.click();
  if (mark) await pause(0.2);
}
const inspector = () => page.getByRole('complementary', { name: 'Future inspector' });
const card = name => page.locator('.future-node').filter({ has: page.locator('.future-name').filter({ hasText: new RegExp(`^${name}$`) }) });
async function toggle(name, on) {
  const control = page.locator('.topbar').getByRole('button', { name, exact: true });
  if (await control.getAttribute('aria-pressed') !== String(on)) await click(control, false);
}
async function shrink() {
  const button = page.getByRole('button', { name: 'Shrink', exact: true });
  if (await button.isVisible()) await click(button, false);
}
async function graph() {
  await shrink();
  await toggle('Portal', false);
  await toggle('Inspect', false);
  await click(page.getByRole('button', { name: 'Fit', exact: true }), false);
}
async function inspect(name) {
  await shrink();
  await toggle('Portal', false);
  await toggle('Futures', true);
  await click(page.locator('.branch-row').filter({ has: page.locator('.row-name').filter({ hasText: name }) }));
  await toggle('Inspect', true);
  await toggle('Futures', false);
  await expect(inspector()).toBeVisible();
  await expect(inspector().getByRole('heading', { name, exact: true })).toBeVisible();
}
async function preview(modelId) {
  await toggle('Inspect', false);
  await toggle('Portal', true);
  const expand = page.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await click(expand, false);
  const frame = page.frameLocator('iframe[title="Live application"]');
  await expect(frame.locator('#model-name')).not.toHaveText('Loading…', { timeout: 20000 });
  const report = await request('/app/api/wildfire');
  expect(report.model.id).toBe(modelId);
  await expect(frame.locator('#model-name')).toHaveText(report.model.label);
  return frame;
}
async function proof(name, extra = {}) {
  const listing = await request('/api/timelines');
  audit.milestones.push({ name, second: second(), active: listing.active_timeline_id, timelines: listing.timelines.map(item => ({ id: item.id, parent_id: item.parent_id, name: item.name, is_active: item.is_active })), ...extra });
  await page.screenshot({ path: join(root, 'shots', `${name}.png`) });
  save();
}
async function scene(id, targetSeconds, title, caption, action) {
  const start = second();
  console.log(`SCENE ${id}: ${title}`);
  await action();
  if (recording && second() - start < targetSeconds) await sleep((targetSeconds - second() + start) * 1000);
  audit.scenes.push({ id, title, caption, start, end: second() });
  save();
}
async function finished(accepted, expectedStatus = 'succeeded') {
  await expect.poll(async () => (await request(`/api/generations/${accepted.id}`)).status, { timeout: 90000, intervals: [250, 500, 750] }).toBe(expectedStatus);
  const record = await request(`/api/generations/${accepted.id}`);
  expect(record.provider).toBe('scripted');
  if (expectedStatus === 'succeeded') expect(record.evaluation.checks.every(check => check.status === 'passed')).toBe(true);
  record.validation_log = await request(`/api/generations/${record.id}/logs?stream=validation&tail=2000`);
  record.agent_log = await request(`/api/generations/${record.id}/logs?stream=agent&tail=2000`);
  const patch = await fetch(engine + `/api/generations/${record.id}/diff`);
  record.patch = await patch.text();
  audit.generations[record.name] = record;
  const evaluationLine = record.validation_log.lines.find(line => line.includes('WILDFIRE_EVALUATION '));
  if (evaluationLine) {
    const report = JSON.parse(evaluationLine.slice(evaluationLine.indexOf('WILDFIRE_EVALUATION ') + 20));
    audit.evaluations[report.model.id] = report;
  }
  save();
  return record;
}
async function generate(prompt, name, parent, expectedStatus = 'succeeded') {
  await graph();
  expect(await page.locator('html').getAttribute('data-paradox-engine')).toBe(engine);
  await expect(page.getByLabel('Agent provider')).toHaveValue('scripted');
  await page.getByLabel('Parent future').selectOption(parent);
  await expect(page.getByRole('radio', { name: 'Keep live', exact: true })).toBeChecked();
  await click(page.getByRole('button', { name: 'Name', exact: true }), false);
  await page.getByPlaceholder('e.g. Popularity ranking').fill(name);
  await click(page.getByRole('button', { name: 'Less', exact: true }), false);
  await page.getByLabel('What would you like to change?').fill(prompt);
  const currentActive = (await request('/api/timelines')).active_timeline_id;
  await pause(0.7);
  const posted = page.waitForResponse(response => response.url() === engine + '/api/generations' && response.request().method() === 'POST');
  await click(page.getByRole('button', { name: 'Generate future', exact: true }));
  const response = await posted;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON()).toMatchObject({ provider: 'scripted', parent_id: parent, activate_on_success: false });
  const result = await finished(await response.json(), expectedStatus);
  expect((await request('/api/timelines')).active_timeline_id).toBe(currentActive);
  await pause(1);
  return result;
}
async function activate(record) {
  await inspect(record.name);
  await click(inspector().getByRole('button', { name: 'Make live', exact: true }));
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await pause(1);
  await click(page.getByRole('alertdialog').getByRole('button', { name: 'Switch runtime', exact: true }));
  await expect(page.getByText(`Live · ${record.name}`, { exact: true })).toBeVisible({ timeout: 20000 });
  expect((await request('/api/timelines')).active_timeline_id).toBe(record.timeline_id);
}

try {
  await free(enginePort); await free(studioPort);
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), PYTHONDONTWRITEBYTECODE: '1', PARADOX_AGENT: 'scripted', PARADOX_SCRIPTED_RECIPES: join(repo, 'tests/fixtures/scripted_agent/wildfire'), PARADOX_SOURCE_DIR: join(repo, 'demo_app'), PARADOX_STATE_DIR: join(root, 'state'), PARADOX_CORS_ORIGINS: `${studio},http://localhost:${studioPort}` };
  start(join(repo, '.venv/bin/python'), ['-I', '-c', `import sys;sys.dont_write_bytecode=True;sys.path.insert(0,${JSON.stringify(repo)});from pathlib import Path;import uvicorn;from engine.api import create_app;uvicorn.run(create_app(state_dir=Path(${JSON.stringify(join(root, 'state'))}),runtime_port=0),host='127.0.0.1',port=${enginePort},log_level='warning')`], root, env, 'engine');
  start(process.execPath, [join(repo, 'apps/studio/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(studioPort), '--strictPort'], join(repo, 'apps/studio'), { ...env, VITE_PARADOX_API_BASE: engine }, 'studio');
  await waitUrl(engine + '/api/health'); await waitUrl(studio);
  const listing = await request('/api/timelines');
  expect(listing.timelines).toHaveLength(1);
  expect((await request('/api/generations')).generations).toHaveLength(0);
  expect((await request('/api/agents')).default).toBe('scripted');
  audit.original = listing.active_timeline_id;
  const originalReport = await request('/app/api/wildfire');
  expect(originalReport.model.id).toBe('original');
  audit.evaluations.original = originalReport;
  await request('/app/api/posts', 'POST', { author: 'Research notebook', content: 'Original reference state — preserved snapshot.' });
  const originalSnapshot = await request(`/api/timelines/${audit.original}/snapshots`, 'POST', {});
  audit.restoreSnapshot = originalSnapshot.id;
  const originalPosts = await request('/app/api/posts');
  const modelA = await finished(await request('/api/generations', 'POST', { parent_id: audit.original, provider: 'scripted', prompt: 'wildfire model a', name: 'Model A · Linear', activate_on_success: false }));
  expect(modelA.parent_id).toBe(audit.original);
  console.log(`OUTPUT ${root}`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1, ...(recording ? { recordVideo: { dir: join(root, 'raw'), size: { width: 1600, height: 800 } } } : {}) });
  await context.route('**/*', async route => {
    const current = route.request();
    const url = new URL(current.url());
    if (![engine, studio].includes(url.origin)) { audit.violations.push(`External origin ${url.origin}`); return route.abort(); }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(current.method())) {
      const body = current.postDataJSON();
      if (url.origin !== engine || (url.pathname === '/api/generations' && (body?.provider !== 'scripted' || body?.activate_on_success !== false))) { audit.violations.push(`Refused ${url.pathname}`); return route.abort(); }
      audit.mutations.push({ second: second(), method: current.method(), path: url.pathname, body });
    }
    await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => audit.errors.push(error.message));
  const video = page.video();
  const videoClock = performance.now();
  await page.goto(studio);
  await expect(page.getByText('Live · Original', { exact: true })).toBeVisible();
  await graph();
  clock = performance.now();
  audit.trimStart = (clock - videoClock) / 1000;
  let modelB;
  let preferred;
  let unsafe;
  let failed;
  let hardened;
  await scene('01', 7, 'PARADOX — A SOFTWARE TIME MACHINE', 'One working application. Many possible futures.', async () => proof('01-universal-opening'));
  await scene('02', 16, 'TODAY: NASA-DERIVED WILDFIRE OBSERVATIONS', 'A real offline dataset. An observational model—not a fire-spread forecast.', async () => {
    const frame = await preview('original');
    await expect(frame.locator('#metric-mae')).not.toHaveText('—');
    await proof('02-original-dataset', { report: originalReport });
    await pause(5);
    await frame.locator('.plots').scrollIntoViewIfNeeded();
    await proof('02b-observation-and-prediction-plots');
    await request('/app/api/posts', 'POST', { author: 'Research notebook', content: 'Transient experiment note — absent after snapshot restoration.' });
  });
  await scene('03', 14, 'CREATE A DIFFERENT IMPLEMENTATION', 'Scripted applies a real code patch. Original stays live.', async () => {
    modelB = await generate('wildfire model b', 'Model B · Ridge', audit.original);
    expect(modelB.parent_id).toBe(audit.original);
    await proof('03-two-model-futures');
  });
  await scene('04', 12, 'REAL CODE. REAL ALTERNATIVES.', 'Python implementations, independent snapshots, inspectable changes.', async () => {
    await inspect(modelB.name);
    await click(inspector().getByRole('tab', { name: 'Diff', exact: true }));
    await expect(inspector().getByText('demo_app/model.py', { exact: true }).first()).toBeVisible();
    await proof('04-model-source-diff');
  });
  await scene('05', 10, 'VALIDATE BEFORE ADOPTION', 'Compilation, tests, boot and HTTP checks run in the actual engine.', async () => {
    await click(inspector().getByRole('tab', { name: 'Tests', exact: true }));
    await expect(inspector().getByText('All six checks passed')).toBeVisible();
    await proof('05-model-validation');
  });
  await scene('06', 10, 'MEASUREMENTS STAY WITH THE FUTURE', 'MAE and RMSE come from the same frozen held-out observations.', async () => {
    await click(inspector().getByRole('tab', { name: 'Logs', exact: true }));
    await expect(inspector().getByText(/WILDFIRE_EVALUATION/).first()).toBeVisible();
    await inspector().locator('.log-line').filter({ hasText: 'MEASURED MODEL:' }).first().scrollIntoViewIfNeeded();
    await proof('06-evaluation-log');
  });
  await scene('07', 14, 'COMPARE FIRST. NOTHING GOES LIVE.', 'Analyze compares recorded validation, code changes and execution logs.', async () => {
    await click(page.getByRole('button', { name: 'Analyze', exact: true }));
    await page.getByLabel('Future A', { exact: true }).selectOption(`timeline:${modelA.timeline_id}`);
    await page.getByLabel('Future B', { exact: true }).selectOption(`timeline:${modelB.timeline_id}`);
    await click(page.getByRole('tab', { name: 'Validation', exact: true }));
    await expect(page.getByRole('table')).toBeVisible();
    await proof('07-comparison-no-activation');
    await pause(3);
    await click(page.getByRole('tab', { name: 'Diffs', exact: true }));
    expect((await request('/api/timelines')).active_timeline_id).toBe(audit.original);
    const metricsA = audit.evaluations.model_a;
    const metricsB = audit.evaluations.model_b;
    if (!metricsA || !metricsB) throw Error('Missing genuine evaluation logs');
    expect(metricsA.dataset.sha256).toBe(metricsB.dataset.sha256);
    expect(metricsA.dataset.test_rows).toBe(metricsB.dataset.test_rows);
    preferred = metricsB.metrics.rmse <= metricsA.metrics.rmse ? modelB : modelA;
    audit.preferred = preferred.id;
    audit.selectionRule = 'Lower held-out RMSE, chosen only after both recorded evaluations; no preselected winner.';
  });
  await scene('08', 12, 'A SYSTEM BEHIND EVERY EXPERIMENT', 'React + TypeScript · React Flow · Python + FastAPI · SQLite', async () => {
    await click(page.getByRole('button', { name: 'Architect', exact: true }));
    await click(page.getByRole('button', { name: 'Fit map', exact: true }), false);
    await pause(3);
    for (let zoom = 0; zoom < 6; zoom++) await click(page.getByRole('button', { name: 'Zoom architecture in', exact: true }), false);
    await click(page.getByRole('button', { name: /^Timeline engine,/ }));
    await expect(page.getByRole('heading', { name: 'Timeline engine', exact: true })).toBeVisible();
    await proof('08-architecture');
  });
  await scene('08B', 8, 'FACTORY DROID SDK ADAPTER IMPLEMENTED', 'This wildfire demonstration uses Scripted—not a Factory-generated run.', async () => {
    await click(page.getByRole('button', { name: /^droid,/ }));
    await expect(page.getByRole('heading', { name: 'droid', exact: true })).toBeVisible();
    await proof('08B-provider-provenance');
  });
  await scene('09A', 14, 'RUN THE LINEAR IMPLEMENTATION', 'Explicit activation loads Model A. Its measured results come from real execution.', async () => {
    await click(page.getByRole('button', { name: 'Explore', exact: true }));
    await activate(modelA);
    await preview('model_a');
    await proof('09A-linear-model-live', { report: await request('/app/api/wildfire') });
  });
  await scene('09B', 14, 'ACTIVATE ONLY WHEN YOU DECIDE', 'The preferred implementation becomes the real running application.', async () => {
    await activate(preferred);
    const report = await request('/app/api/wildfire');
    await preview(report.model.id);
    await proof('09-model-activated', { report });
  });
  await scene('10', 18, 'BRANCH AGAIN: A CONTROLLED INPUT DEFECT', 'An implementation can pass functional tests and still miss an input boundary.', async () => {
    unsafe = await generate('wildfire unsafe input', 'Input experiment', preferred.timeline_id);
    expect(unsafe.parent_id).toBe(preferred.timeline_id);
    await activate(unsafe);
    const report = await request('/app/api/wildfire');
    const frame = await preview(report.model.id);
    await frame.locator('#brightness').fill('-10');
    await click(frame.locator('#predict-button'));
    await expect(frame.locator('#prediction-result')).toContainText('200');
    await frame.locator('#prediction-result').scrollIntoViewIfNeeded();
    await expect(frame.locator('#prediction-result')).toBeInViewport();
    await proof('10-invalid-input-accepted');
  });
  await scene('11', 16, 'THE SECURITY CHECK FAILS — FOR REAL', 'The failed generation is recorded, not adopted as a runnable future.', async () => {
    failed = await generate('wildfire security check', 'Reject invalid input', unsafe.timeline_id, 'failed');
    expect(failed.timeline_id).toBeNull();
    expect(failed.error.stage).toBe('tests');
    expect(failed.validation_log.lines.join('\n')).toMatch(/422|assert/);
    await click(page.locator('.submission').getByRole('button', { name: 'Inspect', exact: true }));
    await click(inspector().getByRole('tab', { name: 'Logs', exact: true }));
    await expect(inspector()).toContainText('422');
    await inspector().locator('.log-line').filter({ hasText: /assert.*422/ }).first().scrollIntoViewIfNeeded();
    await proof('11-genuine-security-failure');
  });
  await scene('12', 18, 'FIX THE BOUNDARY. VERIFY THE CHILD.', 'A hardened child passes the same regression and preserves valid predictions.', async () => {
    hardened = await generate('wildfire harden input', 'Hardened input', unsafe.timeline_id);
    expect(hardened.parent_id).toBe(unsafe.timeline_id);
    await inspect(hardened.name);
    await click(inspector().getByRole('tab', { name: 'Tests', exact: true }));
    await expect(inspector().getByText('All six checks passed')).toBeVisible();
    await proof('12-hardened-validation');
    await pause(4);
    await click(inspector().getByRole('tab', { name: 'Diff', exact: true }));
    await inspector().getByText('demo_app/tests/test_wildfire_security.py', { exact: true }).scrollIntoViewIfNeeded();
    await proof('12b-same-security-regression');
  });
  await scene('13', 14, 'EXPLICIT ADOPTION. VERIFIED REJECTION.', 'HTTP 422 for invalid input. HTTP 200 for legitimate observations.', async () => {
    await activate(hardened);
    const report = await request('/app/api/wildfire');
    const frame = await preview(report.model.id);
    await frame.locator('#brightness').fill('-10');
    await click(frame.locator('#predict-button'));
    await expect(frame.locator('#prediction-result')).toContainText('422');
    await frame.locator('#prediction-result').scrollIntoViewIfNeeded();
    await expect(frame.locator('#prediction-result')).toBeInViewport();
    await proof('13-hardened-rejection');
    await pause(4);
    await frame.locator('#brightness').fill('330');
    await click(frame.locator('#predict-button'));
    await expect(frame.locator('#prediction-result')).toContainText('200');
    await frame.locator('#prediction-result').scrollIntoViewIfNeeded();
    await expect(frame.locator('#prediction-result')).toBeInViewport();
    await proof('13b-legitimate-input-preserved');
  });
  await scene('14', 18, 'RESTORE IMPLEMENTATION AND SAVED STATE', 'Original returns. The experimental history remains inspectable.', async () => {
    await inspect('Original');
    await click(inspector().getByRole('tab', { name: 'Snapshots', exact: true }));
    const saved = inspector().locator('.snapshot').filter({ hasText: audit.restoreSnapshot.slice(0, 8) });
    await click(saved.getByRole('button', { name: 'Restore', exact: true }));
    await expect(page.getByRole('alertdialog')).toContainText('Original');
    await pause(1);
    await click(page.getByRole('alertdialog').getByRole('button', { name: 'Restore and go live', exact: true }));
    await expect(page.getByText('Live · Original', { exact: true })).toBeVisible({ timeout: 20000 });
    const frame = await preview('original');
    expect(await request('/app/api/posts')).toEqual(originalPosts);
    const notebook = frame.locator('details');
    await notebook.locator('summary').click();
    await expect(frame.getByText('Original reference state — preserved snapshot.', { exact: true })).toBeVisible();
    await expect(frame.getByText('Transient experiment note — absent after snapshot restoration.', { exact: true })).toHaveCount(0);
    await frame.locator('#notebook-posts').scrollIntoViewIfNeeded();
    await expect(frame.getByText('Original reference state — preserved snapshot.', { exact: true })).toBeInViewport();
    await proof('14-original-code-and-state-restored', { posts: originalPosts });
  });
  await scene('15', 8, 'PARADOX — EXPLORE EVERY FUTURE', 'For software experiments: APIs, algorithms, data pipelines and beyond.', async () => {
    await graph();
    expect((await request('/api/timelines')).timelines).toHaveLength(5);
    await proof('15-preserved-history');
  });
  expect(audit.violations).toEqual([]);
  expect(audit.errors).toEqual([]);
  audit.passed = true;
  audit.duration = second();
  await context.close();
  if (video) audit.videoPath = await video.path();
  save();
  writeFileSync(join(output, recording ? 'latest-take.txt' : 'latest-rehearsal.txt'), root);
  console.log(JSON.stringify({ passed: true, root, duration: audit.duration, videoPath: audit.videoPath, evaluations: Object.fromEntries(Object.entries(audit.evaluations).map(([key, report]) => [key, report.metrics])) }, null, 2));
} catch (error) {
  audit.failure = String(error.stack || error);
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  save();
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
}
