import { expect, test, type Page } from "@playwright/test";
import { assertBrowserTarget, installFirewall, verifyIsolatedEngine, type Firewall } from "./guard.ts";
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

async function engineState(page: Page) {
  const response = await page.request.get(`${ENGINE}/api/timelines`);
  return (await response.json()) as { active_timeline_id: string; timelines: Array<{ id: string; name: string; status: string; is_active: boolean }> };
}

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
