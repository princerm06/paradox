import { expect, test, type Page } from "@playwright/test";
import { assertBrowserTarget, holdNextGenerationResponse, installFirewall, verifyIsolatedEngine, type Firewall } from "./guard.ts";
import { E2E_ENGINE as ENGINE } from "./target.mjs";

const SHOTS = process.env.PARADOX_E2E_SHOTS ?? "";

let allowed: string[] = [];
let firewall: Firewall;

// Fails closed before any browser opens unless ENGINE is the fresh engine
// Playwright started for this run (see playwright.config.ts).
test.beforeAll(async ({ request }) => {
  allowed = await verifyIsolatedEngine(request);
});

test.beforeEach(async ({ context }) => {
  // Fresh context per test: no storage, so no stale Settings override.
  firewall = await installFirewall(context, allowed);
});

test.afterEach(() => {
  expect(firewall.violations, "requests the E2E firewall blocked").toEqual([]);
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("redesigned Explore keeps panels separated across viewport sizes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Live · Original")).toBeVisible();
  await assertBrowserTarget(page);
  await expect(page.locator(".topbar-brand img")).toHaveJSProperty("naturalWidth", 96);
  await page.locator(".topbar").getByRole("button", { name: "Inspect" }).click();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "Software Futures" })).toBeVisible();
    const graph = await page.locator(".graph-host").boundingBox();
    const composer = await page.locator(".composer-dock").boundingBox();
    const preview = await page.locator(".portal-float").boundingBox();
    const inspector = await page.locator(".inspector-float").boundingBox();
    expect(graph).not.toBeNull();
    expect(composer!.y).toBeGreaterThanOrEqual(graph!.y + graph!.height - 1);
    expect(inspector!.y).toBeGreaterThanOrEqual(preview!.y + preview!.height - 1);
    if (viewport.width > 980) expect(preview!.x).toBeGreaterThanOrEqual(graph!.x + graph!.width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(async () => {
      const card = await page.locator(".future-node.is-selected").boundingBox();
      const canvas = await page.locator(".graph-host").boundingBox();
      return Boolean(card && canvas && card.x >= canvas.x && card.x + card.width <= canvas.x + canvas.width);
    }).toBe(true);
    await shot(page, `redesign-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  const expanded = await page.locator(".portal-float").boundingBox();
  const graph = await page.locator(".graph-host").boundingBox();
  expect(expanded!.x).toBeGreaterThanOrEqual(graph!.x + graph!.width - 1);
  await page.getByRole("button", { name: "Shrink", exact: true }).click();
});

async function engineState(page: Page) {
  const response = await page.request.get(`${ENGINE}/api/timelines`);
  return (await response.json()) as { active_timeline_id: string; timelines: Array<{ id: string; name: string; status: string; is_active: boolean }> };
}

test("Architect exposes provenance and responsive inspection without mutations", async ({ page }) => {
  const before = await engineState(page);
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().startsWith(ENGINE) && request.method() !== "GET" && request.method() !== "OPTIONS") mutations.push(request.url());
  });
  await page.goto("/#architect");
  await assertBrowserTarget(page);
  await expect(page.getByRole("heading", { name: "System Architecture" })).toBeVisible();
  await expect(page.getByText("System context, not an imported-project topology.")).toBeVisible();
  await page.getByRole("button", { name: /^Timeline engine,/ }).click();
  const inspector = page.getByRole("complementary", { name: "Architecture inspector" });
  await expect(inspector.getByRole("heading", { name: "Timeline engine" })).toBeVisible();
  await expect(inspector.getByText("GET /api/health", { exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "→ Timeline store" }).click();
  await expect(inspector.getByRole("heading", { name: "Timeline store" })).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Timeline store" })).toBeInViewport();
  await page.getByRole("button", { name: "Fit map" }).click();
  const initialZoom = await page.getByLabel("Architecture zoom", { exact: true }).textContent();
  await page.getByRole("button", { name: "Zoom architecture in" }).click();
  await expect(page.getByLabel("Architecture zoom", { exact: true })).not.toHaveText(initialZoom!);
  await page.getByRole("button", { name: "Zoom architecture out" }).click();
  for (const viewport of [{ width: 1440, height: 960 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const cards = await page.locator(".arch-node").evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }));
    for (let first = 0; first < cards.length; first++) {
      for (let second = first + 1; second < cards.length; second++) {
        const left = cards[first]!;
        const right = cards[second]!;
        expect(left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top, "architecture cards must not overlap").toBe(true);
      }
    }
    await shot(page, `architect-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("tab", { name: /^Endpoints/ }).click();
  await expect(page.getByText("GET /openapi.json", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Changes/ }).click();
  await expect(page.getByText("Generation records and diffs, without inferred runtime claims.")).toBeVisible();
  await expect(inspector.getByText("Imported-project topology and architecture comparison")).toBeVisible();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(await engineState(page)).toEqual(before);
});

async function generate(page: Page, prompt: string) {
  await page.getByLabel("What would you like to change?").fill(prompt);
  await expect(page.getByLabel("Agent provider")).toHaveValue("scripted");
  await assertBrowserTarget(page);
  const sent = page.waitForRequest((request) => request.method() === "POST" && request.url() === `${ENGINE}/api/generations`);
  await page.getByRole("button", { name: /Generate future/ }).click();
  // Verify the payload actually sent, not just the UI label.
  expect((await sent).postDataJSON()).toMatchObject({ prompt, provider: "scripted", activate_on_success: false });
}

/** Click a control that mutates the engine, after re-verifying the target. */
async function mutate(page: Page, click: () => Promise<void>) {
  await assertBrowserTarget(page);
  await click();
}

test("guard rejects a browser whose Settings override points at another engine", async ({ page }) => {
  // Reproduces the audited mismatch: env says the isolated engine, storage says :8000.
  await page.addInitScript(() => localStorage.setItem("paradox.apiBase", "http://127.0.0.1:8000"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-paradox-engine", "http://127.0.0.1:8000");
  await expect(assertBrowserTarget(page)).rejects.toThrow(/bound to http:\/\/127\.0\.0\.1:8000 .*not the isolated engine/);

  // Even if a mutation slipped past the assertion, the firewall stops it.
  const wrongEngine = await page.evaluate(() =>
    fetch("http://127.0.0.1:8000/api/timelines/x/activate", { method: "POST", body: "", headers: { "Content-Type": "text/plain" } }).then(
      () => "sent",
      () => "blocked",
    ),
  );
  const paid = await page.evaluate(
    (engine) =>
      fetch(`${engine}/api/generations`, { method: "POST", body: JSON.stringify({ parent_id: "x", prompt: "x", provider: "droid" }), headers: { "Content-Type": "text/plain" } }).then(
        () => "sent",
        () => "blocked",
      ),
    ENGINE,
  );
  expect([wrongEngine, paid]).toEqual(["blocked", "blocked"]);
  expect(firewall.violations).toEqual([
    expect.stringContaining("POST http://127.0.0.1:8000/api/timelines/x/activate"),
    expect.stringContaining('provider "droid" is not "scripted"'),
  ]);
  firewall.violations = [];
  // Nothing reached the isolated engine either.
  const state = await engineState(page);
  expect(state.timelines).toHaveLength(1);
});


async function selectInFutures(page: Page, name: string) {
  const panel = page.getByRole("complementary", { name: "Futures" });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Futures" }).first().click();
  await panel.getByText(name, { exact: true }).first().click();
}

test("full Explore workflow against an isolated engine", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Live · Original")).toBeVisible();
  await assertBrowserTarget(page);
  await shot(page, "iso-01-first-load");

  // 1. Generate a successful future; it must not go live by itself.
  await generate(page, "Add a popular ranking");
  await expect(page.locator(".submission")).toContainText(/Queued|Preparing|Generating|Validating/);
  await expect(page.locator(".submission")).toContainText("The new future is pending", { timeout: 60_000 });
  await expect(page.getByText("Live · Original")).toBeVisible();
  let state = await engineState(page);
  const popular = state.timelines.find((item) => item.name === "Add a popular ranking")!;
  expect(popular.status).toBe("pending");
  expect(state.active_timeline_id).not.toBe(popular.id);
  await shot(page, "iso-02-generated-pending");

  // 2. Inspect its evidence.
  await page.locator(".submission").getByRole("button", { name: "Inspect" }).click();
  const inspector = page.getByRole("complementary", { name: "Future inspector" });
  await expect(page.locator(".future-node.is-selected .future-selection")).toHaveText("Selected");
  await expect(page.locator(".future-node.is-selected .state-live")).toHaveCount(0);
  await expect(page.locator(".future-node.is-live .state-live")).toHaveText("Live");
  await expect(page.locator(".future-node.is-selected .future-visual")).toHaveAccessibleName("Application capture unavailable");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect.poll(async () => page.locator(".future-node").evaluateAll((cards) => {
    const host = document.querySelector(".graph-host")!.getBoundingClientRect();
    return cards.every((card) => {
      const rect = card.getBoundingClientRect();
      return rect.left >= host.left && rect.right <= host.right && rect.top >= host.top && rect.bottom <= host.bottom;
    });
  })).toBe(true);
  const zoom = page.getByLabel("Current zoom", { exact: true });
  const beforeZoom = Number.parseInt(await zoom.innerText());
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(async () => Number.parseInt(await zoom.innerText())).toBeGreaterThan(beforeZoom);
  await page.getByRole("button", { name: "Center", exact: true }).click();
  await inspector.getByRole("tab", { name: "Diff" }).click();
  await expect(inspector.getByText("demo_app/ranking.py").first()).toBeVisible();
  await shot(page, "iso-03-inspector-diff");
  await inspector.getByRole("tab", { name: "Tests" }).click();
  await expect(inspector.getByText("All six checks passed")).toBeVisible();
  await shot(page, "iso-04-inspector-tests");

  // 3. Make it live through the confirmation dialog.
  await inspector.getByRole("button", { name: "Make live" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("switches from Original to Add a popular ranking");
  await shot(page, "iso-05-activate-dialog");
  await mutate(page, () => dialog.getByRole("button", { name: "Switch runtime" }).click());
  await expect(page.getByText("Live · Add a popular ranking")).toBeVisible();
  state = await engineState(page);
  expect(state.active_timeline_id).toBe(popular.id);
  await expect(page.frameLocator("iframe[title='Live application']").getByText(/popular/i).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "iso-06-activated");

  // 4. Save a snapshot of the live future.
  await mutate(page, () => inspector.getByRole("button", { name: "Save snapshot" }).click());
  await expect(inspector.getByText("Engine saved a snapshot of the live code and data.")).toBeVisible();
  await inspector.getByRole("tab", { name: "Snapshots" }).click();
  await expect(inspector.locator(".snapshot")).not.toHaveCount(0);
  await shot(page, "iso-07-snapshots");

  // 5. A failing generation stays a red ghost and creates no timeline.
  await generate(page, "break the app");
  await expect(page.locator(".submission")).toContainText("Failed · compile", { timeout: 60_000 });
  state = await engineState(page);
  expect(state.timelines.some((item) => item.name === "break the app")).toBe(false);
  await shot(page, "iso-08-failed-generation");

  // 6. Cancel a slow generation; the UI reports cancellation only from the engine.
  await generate(page, "slow rehearsal");
  await expect(page.locator(".submission")).toContainText(/Queued|Preparing|Generating/);
  await mutate(page, () => page.locator(".submission").getByRole("button", { name: "Cancel" }).click());
  await expect(page.locator(".submission")).toContainText("Cancelled", { timeout: 20_000 });
  const generations = (await (await page.request.get(`${ENGINE}/api/generations`)).json()) as { generations: Array<{ name: string; status: string }> };
  expect(generations.generations.find((item) => item.name === "slow rehearsal")?.status).toBe("cancelled");
  await shot(page, "iso-09-cancelled");

  // 7. Restore Original's snapshot (activates Original).
  await selectInFutures(page, "Original");
  if (!(await inspector.isVisible())) await page.getByRole("button", { name: "Inspect" }).first().click();
  await inspector.getByRole("tab", { name: "Snapshots" }).click();
  await inspector.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByRole("alertdialog")).toContainText("Restores Original");
  await mutate(page, () => page.getByRole("alertdialog").getByRole("button", { name: "Restore and go live" }).click());
  await expect(page.getByText("Live · Original")).toBeVisible();
  expect((await engineState(page)).active_timeline_id).not.toBe(popular.id);
  await shot(page, "iso-10-restored");

  // 8. Decline the (no longer live) popular future.
  await selectInFutures(page, "Add a popular ranking");
  await inspector.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("The live application is not affected.");
  await mutate(page, () => page.getByRole("alertdialog").getByRole("button", { name: "Decline" }).click());
  await expect.poll(async () => (await engineState(page)).timelines.find((item) => item.id === popular.id)?.status).toBe("declined");
  await shot(page, "iso-11-declined");

  // 9. Analyze and Architect over the real records, with no further mutations.
  const before = JSON.stringify(await engineState(page));
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Compare futures")).toBeVisible();
  await shot(page, "iso-12-analyze");
  await page.getByRole("tab", { name: "Validation" }).click();
  await shot(page, "iso-13-analyze-validation");
  await page.getByRole("button", { name: "Architect" }).click();
  await expect(page.locator(".arch-node-label", { hasText: "Timeline engine" })).toBeVisible();
  await shot(page, "iso-14-architect");
  await page.getByRole("tab", { name: /^Changes/ }).click();
  const architecture = page.getByRole("region", { name: "Architecture map" });
  await architecture.getByRole("button", { name: /^M ranking.py/ }).click();
  const component = page.getByRole("complementary", { name: "Architecture inspector" });
  await expect(component.getByText("scripted agent")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const changeMap = await page.locator(".change-map").boundingBox();
  expect(changeMap!.height).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const panel = await component.boundingBox();
  const stage = await architecture.boundingBox();
  expect(panel!.y).toBeGreaterThanOrEqual(stage!.y + stage!.height - 1);
  await shot(page, "architect-populated-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(JSON.stringify(await engineState(page))).toBe(before);
  // Every generation the browser sent asked for the scripted provider explicitly.
  expect(firewall.generations.map((body) => body.provider)).toEqual(["scripted", "scripted", "scripted"]);
});

test("refresh during a generation reattaches it, and Confirm never activates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Live · Original")).toBeVisible();
  const liveBefore = (await engineState(page)).active_timeline_id;

  await generate(page, "slow refresh check");
  await expect(page.locator(".submission")).toContainText(/Queued|Preparing|Generating/);
  await page.locator(".submission").getByRole("button", { name: "Inspect" }).click();
  await page.reload();

  // The strip and the inspector come back from the engine's record; nothing is resubmitted.
  const strip = page.locator(".submission");
  await expect(strip).toContainText("slow refresh check");
  await expect(strip).toContainText("Restored after reload");
  await expect(strip.getByRole("button", { name: "Cancel" })).toBeVisible();
  const inspector = page.getByRole("complementary", { name: "Future inspector" });
  await expect(inspector.getByRole("heading", { name: "slow refresh check" })).toBeVisible();
  await shot(page, "iso-15-refresh-reattached");
  await expect(strip).toContainText("The new future is pending", { timeout: 60_000 });
  expect(firewall.generations).toHaveLength(1);
  const all = (await (await page.request.get(`${ENGINE}/api/generations`)).json()) as { generations: Array<{ prompt: string }> };
  expect(all.generations.filter((item) => item.prompt === "slow refresh check")).toHaveLength(1);

  // Confirm keeps it in history without making it live.
  await strip.getByRole("button", { name: "Inspect" }).click();
  await inspector.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("does not change what is live");
  await mutate(page, () => page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click());
  await expect.poll(async () => (await engineState(page)).timelines.find((item) => item.name === "slow refresh check")?.status).toBe("confirmed");
  expect((await engineState(page)).active_timeline_id).toBe(liveBefore);
  await expect(page.getByText("Live · Original")).toBeVisible();
  await shot(page, "iso-16-confirmed-not-live");
});

type EngineGeneration = { id: string; prompt: string; status: string; parent_id: string; provider: string; activate_on_success: boolean };

async function engineGenerations(page: Page) {
  return ((await (await page.request.get(`${ENGINE}/api/generations`)).json()) as { generations: EngineGeneration[] }).generations;
}

async function waitForStatus(page: Page, id: string, statuses: string[]) {
  await expect.poll(async () => (await engineGenerations(page)).find((item) => item.id === id)?.status, { timeout: 60_000 }).toMatch(new RegExp(`^(${statuses.join("|")})$`));
}

const UNCONFIRMED = "did not confirm this was the tab's own request";

test("A3: reload before the generation response shows the engine's new record, never the previous submission", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^Live · /).first()).toBeVisible();
  const strip = page.locator(".submission");
  await generate(page, "popular baseline before delay");
  await expect(strip).toContainText("The new future is pending", { timeout: 60_000 });
  const before = await engineGenerations(page);

  const held = await holdNextGenerationResponse(page, firewall);
  await generate(page, "slow delayed response");
  const accepted = await held.accepted;
  expect(accepted.status).toBe(202);
  const createdId = String(accepted.body.id);
  const during = await engineGenerations(page);
  expect(during.filter((item) => item.prompt === "slow delayed response").map((item) => item.id)).toEqual([createdId]);
  await expect(page.getByRole("button", { name: /Starting/ })).toBeVisible();
  await shot(page, "iso-17-held-response");

  await page.reload();
  await expect(strip).toContainText("slow delayed response");
  await expect(strip).not.toContainText("popular baseline before delay");
  await expect(strip).toContainText("Recovered without the engine's response");
  await expect(strip).toContainText(UNCONFIRMED);
  await shot(page, "iso-18-recovered-after-reload");
  await mutate(page, () => strip.getByRole("button", { name: "Cancel" }).click());
  await expect(strip).toContainText("Cancelled", { timeout: 20_000 });
  await waitForStatus(page, createdId, ["cancelled"]);

  const after = await engineGenerations(page);
  expect(after.filter((item) => item.prompt === "slow delayed response")).toHaveLength(1);
  for (const item of before) expect(after.some((next) => next.id === item.id)).toBe(true);
  expect(firewall.generations.map((body) => body.prompt)).toEqual(["popular baseline before delay", "slow delayed response"]);
});

test("A3: a run that completes during the reload is shown with its real outcome", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^Live · /).first()).toBeVisible();
  const held = await holdNextGenerationResponse(page, firewall);
  await generate(page, "popular finished during reload");
  const createdId = String((await held.accepted).body.id);
  await waitForStatus(page, createdId, ["succeeded"]);
  await page.reload();
  const strip = page.locator(".submission");
  await expect(strip).toContainText("popular finished during reload");
  await expect(strip).toContainText("The new future is pending");
  await expect(strip).toContainText(UNCONFIRMED);
  await expect(strip.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  expect(firewall.generations).toHaveLength(1);
});

test("A3: identical concurrent submissions are listed, not guessed, and nothing is resubmitted", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^Live · /).first()).toBeVisible();
  const held = await holdNextGenerationResponse(page, firewall);
  await generate(page, "slow twin request");
  const mine = (await held.accepted).body as unknown as EngineGeneration;
  await assertBrowserTarget(page);
  const otherStatus = await page.evaluate(
    async ({ engine, body }) => (await fetch(`${engine}/api/generations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status,
    { engine: ENGINE, body: { parent_id: mine.parent_id, prompt: mine.prompt, provider: mine.provider, activate_on_success: mine.activate_on_success } },
  );
  expect(otherStatus).toBe(202);
  await page.reload();

  const panel = page.getByRole("group", { name: "Unconfirmed submission" });
  await expect(panel).toContainText("2 engine records match");
  await expect(page.locator(".submission")).toHaveCount(0);
  await shot(page, "iso-19-ambiguous-candidates");
  const rows = panel.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    const cancel = rows.nth(index).getByRole("button", { name: "Cancel" });
    if (await cancel.count()) await mutate(page, () => cancel.click());
  }
  const twins = (await engineGenerations(page)).filter((item) => item.prompt === "slow twin request");
  expect(twins).toHaveLength(2);
  for (const twin of twins) await waitForStatus(page, twin.id, ["cancelled", "succeeded", "failed"]);
  await rows.first().getByRole("button", { name: "Track this one" }).click();
  await expect(page.locator(".submission")).toContainText(UNCONFIRMED);
  await expect(panel).toHaveCount(0);
  expect(firewall.generations).toHaveLength(2);
  expect((await engineGenerations(page)).filter((item) => item.prompt === "slow twin request")).toHaveLength(2);
});

test("A3: a response delivered while another engine is shown is kept for its own engine only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^Live · /).first()).toBeVisible();
  const held = await holdNextGenerationResponse(page, firewall);
  await generate(page, "slow engine switch check");
  const createdId = String((await held.accepted).body.id);

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Studio settings" });
  await settings.getByLabel("Engine URL").fill("http://127.0.0.1:8099");
  await settings.getByRole("button", { name: "Use" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-paradox-engine", "http://127.0.0.1:8099");
  await expect(page.getByRole("group", { name: "Unconfirmed submission" })).toHaveCount(0);
  await expect(page.locator(".submission")).toHaveCount(0);
  await held.release();

  if (!(await settings.isVisible())) await page.getByRole("button", { name: "Settings" }).click();
  await settings.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-paradox-engine", ENGINE);
  await assertBrowserTarget(page);
  const strip = page.locator(".submission");
  await expect(strip).toContainText("slow engine switch check");
  await expect(strip).toContainText("Restored after reload from the engine's record");
  await expect(strip).not.toContainText(UNCONFIRMED);
  await waitForStatus(page, createdId, ["succeeded", "failed", "cancelled"]);
  expect(firewall.generations).toHaveLength(1);
  expect((await engineGenerations(page)).filter((item) => item.prompt === "slow engine switch check")).toHaveLength(1);
});

test("A1/A2: the composer starts on scripted and the live parent, and inspecting a child does not move it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^Live · /).first()).toBeVisible();
  const live = (await engineState(page)).active_timeline_id;
  await expect(page.getByLabel("Agent provider")).toHaveValue("scripted");
  await expect(page.getByLabel("Parent future")).toHaveValue(live);
  await generate(page, "popular child for parent check");
  const strip = page.locator(".submission");
  await expect(strip).toContainText("The new future is pending", { timeout: 60_000 });
  await strip.getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("complementary", { name: "Future inspector" }).getByRole("heading", { name: "popular child for parent check" })).toBeVisible();
  await expect(page.getByLabel("Parent future")).toHaveValue(live);
  await page.reload();
  await expect(page.getByLabel("Parent future")).toHaveValue(live);
  const sent = page.waitForRequest((request) => request.method() === "POST" && request.url() === `${ENGINE}/api/generations`);
  await page.getByLabel("What would you like to change?").fill("break the app parent check");
  await expect(page.getByLabel("Agent provider")).toHaveValue("scripted");
  await assertBrowserTarget(page);
  await page.getByRole("button", { name: /Generate future/ }).click();
  expect((await sent).postDataJSON()).toMatchObject({ parent_id: live, provider: "scripted" });
  expect((await engineState(page)).active_timeline_id).toBe(live);
  await expect(strip).toContainText("Failed", { timeout: 60_000 });
});
