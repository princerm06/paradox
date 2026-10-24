// End-to-end checks for the desktop POC: the bundled studio as served by the .app,
// against the scripted engine the .app launched. Scripted only; never a paid call.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ENGINE, UI, alive, crash, engineEnv, enginePid, launch, quit, resetState, token } from "./app.ts";

test.describe.configure({ mode: "serial" });

type Wall = { mutations: string[]; providers: unknown[]; blocked: string[] };
async function firewall(context: BrowserContext): Promise<Wall> {
  const wall: Wall = { mutations: [], providers: [], blocked: [] };
  await context.route("**/*", async (route) => {
    const r = route.request();
    if (["GET", "HEAD", "OPTIONS"].includes(r.method())) return route.continue();
    const url = new URL(r.url());
    if (url.origin !== ENGINE) {
      wall.blocked.push(`${r.method()} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    wall.mutations.push(`${r.method()} ${url.pathname}`);
    if (url.pathname === "/api/generations") {
      const provider = (r.postDataJSON() as { provider?: string }).provider;
      wall.providers.push(provider);
      if (provider !== "scripted") {
        wall.blocked.push(`provider ${String(provider)}`);
        return route.abort("blockedbyclient");
      }
    }
    return route.continue();
  });
  return wall;
}

/** Same binding the shell's initialization script performs inside the app window. */
async function bind(page: Page, tok: string) {
  await page.addInitScript(([base, t]) => {
    localStorage.removeItem("paradox.apiBase");
    localStorage.setItem(`paradox.token:${base}`, t);
  }, [ENGINE, tok] as const);
}

const api = async <T,>(path: string): Promise<T> => (await (await fetch(ENGINE + path)).json()) as T;
type TL = { active_timeline_id: string; timelines: Array<{ id: string; name: string; status: string; generation_id: string | null }> };
type Gen = { id: string; prompt: string; status: string; provider: string; timeline_id: string | null; error: { stage?: string; message?: string } | null; agent: { summary?: string } | null; evaluation: { tests?: { passed: number; failed: number; errors: number }; checks?: Array<{ name: string; status: string }> } | null };
type GL = { generations: Gen[] };
const SHOTS = process.env.DESKTOP_SHOTS ?? "";
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

let firstToken = "";
let snapshotOfState = "";
/** Durable identity of the history. The live timeline's head snapshot advances when a clean shutdown checkpoints it. */
const history = (list: TL) => JSON.stringify({ active: list.active_timeline_id, timelines: list.timelines.map(({ id, name, status, generation_id, parent_id }) => ({ id, name, status, generation_id, parent_id })) });

test("1. fresh launch: isolated state, keyless engine, per-launch token", async () => {
  resetState();
  await launch();
  const env = engineEnv();
  expect(env).not.toContain("FACTORY_API_KEY");
  expect(env).toContain("PARADOX_AGENT=scripted");
  expect(env).toContain("PARADOX_STATE_DIR=" + process.env.HOME + "/Library/Application Support/dev.paradox.desktop-poc/state");
  firstToken = token();
  const agents = await api<{ default: string; providers: Array<{ id: string; available: boolean }> }>("/api/agents");
  expect(agents.default).toBe("scripted");
  expect(agents.providers.find((p) => p.id === "droid")?.available).toBe(false);
  const root = (await api<TL>("/api/timelines")).active_timeline_id;
  // Unauthenticated and foreign-origin mutations are refused; the token is accepted.
  expect((await fetch(`${ENGINE}/api/timelines/${root}/snapshots`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${ENGINE}/api/timelines/${root}/snapshots`, { method: "POST", headers: { Origin: "https://evil.example", Authorization: `Bearer ${firstToken}` } })).status).toBe(403);
  // Even with the token, an explicit paid provider is refused by a keyless engine before any job exists.
  const paid = await fetch(`${ENGINE}/api/generations`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstToken}`, Origin: UI }, body: JSON.stringify({ parent_id: root, prompt: "x", provider: "droid" }) });
  expect(paid.status).toBe(422);
  expect((await api<GL>("/api/generations")).generations).toHaveLength(0);
});

test("2. full workflow in the bundled studio", async ({ page, context }) => {
  const wall = await firewall(context);
  await bind(page, firstToken);
  const insp = page.getByRole("complementary", { name: "Future inspector" });
  const strip = page.locator(".submission");
  const frame = page.frameLocator("iframe[title='Live application']");
  const select = async (name: string) => {
    await page.locator(".future-node .future-select", { hasText: name }).first().evaluate((el) => (el as HTMLElement).click());
    if (!(await insp.isVisible())) await page.getByRole("button", { name: "Inspect", exact: true }).first().click();
  };
  const generate = async (prompt: string) => {
    await expect(page.getByLabel("Agent provider")).toHaveValue("scripted");
    await page.getByLabel("What would you like to change?").fill(prompt);
    await page.getByRole("button", { name: /Generate future/ }).click();
    await expect(strip).toContainText(prompt);
  };
  const gen = async (prompt: string) => (await api<GL>("/api/generations")).generations.find((g) => g.prompt === prompt)!;

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-paradox-engine", ENGINE);
  await expect(page.getByText("Live · Original")).toBeVisible();
  await expect(page.getByRole("img", { name: /Engine connected/ })).toBeVisible();
  await shot(page, "d01-first-load");

  // Ghost node, live progress and logs on a slow generation.
  await generate("slow ghost check");
  await expect(page.locator(".future-node.is-ghost.is-running")).toHaveCount(1);
  await expect(page.locator(".stepper").first()).toBeVisible();
  await strip.getByRole("button", { name: "Inspect" }).click();
  await insp.getByRole("tab", { name: "Logs" }).click();
  await expect(insp.getByText("Scripted recipe selected").first()).toBeVisible();
  await shot(page, "d02-ghost-progress-logs");
  await expect(strip).toContainText("The new future is pending", { timeout: 90_000 });

  // Popular future: diff and validation shown exactly as the engine reports them.
  await select("Original");
  await generate("Add a popular ranking");
  await expect(strip).toContainText("The new future is pending", { timeout: 90_000 });
  const popular = await gen("Add a popular ranking");
  await strip.getByRole("button", { name: "Inspect" }).click();
  await insp.getByRole("tab", { name: "Diff" }).click();
  const diff = await (await fetch(`${ENGINE}/api/generations/${popular.id}/diff`)).text();
  expect(diff).toContain("demo_app/ranking.py");
  await expect(insp.getByText("demo_app/ranking.py").first()).toBeVisible();
  await insp.getByRole("tab", { name: "Tests" }).click();
  const t = popular.evaluation!.tests!;
  await expect(insp.getByText(`${t.passed} passed`).first()).toBeVisible();
  await expect(insp.getByText("All six checks passed")).toBeVisible();
  for (const check of popular.evaluation!.checks!) await expect(insp.getByText(check.name, { exact: true }).first()).toBeVisible();
  await insp.getByRole("tab", { name: "Overview" }).click();
  await expect(insp.getByText(popular.agent!.summary!)).toBeVisible();
  await shot(page, "d03-diff-validation");

  // Inspection sweep: every node and tab, Architect and Analyze; nothing may mutate or activate.
  const liveBefore = (await api<TL>("/api/timelines")).active_timeline_id;
  const before = wall.mutations.length;
  for (const node of await page.locator(".future-node .future-select").all()) {
    await node.evaluate((el) => (el as HTMLElement).click());
    for (const tab of ["Overview", "Diff", "Logs", "Tests", "Snapshots"]) {
      const handle = insp.getByRole("tab", { name: tab });
      if (await handle.isVisible()) await handle.click();
    }
  }
  await page.getByRole("button", { name: "Architect", exact: true }).click();
  await expect(page.locator(".arch-node-label", { hasText: "Timeline engine" })).toBeVisible();
  for (const lens of ["Endpoints", "Changes", "System"]) await page.getByRole("button", { name: new RegExp(`^${lens}`) }).first().click().catch(() => undefined);
  await shot(page, "d04-architect");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByText("Compare futures")).toBeVisible();
  for (const tab of ["Validation", "Files", "Diffs", "Logs", "Summary"]) await page.getByRole("tab", { name: tab }).click();
  await shot(page, "d05-analyze");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  expect(wall.mutations.slice(before)).toEqual([]);
  expect((await api<TL>("/api/timelines")).active_timeline_id).toBe(liveBefore);
  await expect(page.getByText("Live · Original")).toBeVisible();

  // Activation through the confirmation dialog only.
  await select("Add a popular ranking");
  await insp.getByRole("button", { name: "Make live" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Switch runtime" }).click();
  await expect(page.getByText("Live · Add a popular ranking")).toBeVisible();
  await expect(frame.getByText(/Ordering: popular/)).toBeVisible({ timeout: 20_000 });
  await shot(page, "d06-activated");

  // Snapshot of the live future, then restore Original's snapshot.
  await insp.getByRole("button", { name: "Save snapshot" }).click();
  await expect(insp.getByText("Engine saved a snapshot of the live code and data.")).toBeVisible();
  await select("Original");
  await insp.getByRole("tab", { name: "Snapshots" }).click();
  await insp.getByRole("button", { name: "Restore" }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore and go live" }).click();
  await expect(page.getByText("Live · Original")).toBeVisible();
  await expect(frame.getByText(/Ordering: chronological/)).toBeVisible({ timeout: 20_000 });

  // A failing future stays a red ghost with no timeline.
  await select("Original");
  await generate("break the app");
  await expect(strip).toContainText("Failed · compile", { timeout: 90_000 });
  expect((await gen("break the app")).timeline_id).toBeNull();

  // Cancellation is reported from the engine's record.
  await select("Original");
  await generate("slow cancel check");
  await strip.getByRole("button", { name: "Cancel" }).click();
  await expect(strip).toContainText("Cancelled", { timeout: 20_000 });
  expect((await gen("slow cancel check")).status).toBe("cancelled");

  // Refresh mid-generation reattaches without resubmitting.
  await select("Original");
  await generate("slow refresh check");
  await expect(strip.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.reload();
  await expect(strip).toContainText("slow refresh check");
  await expect(strip).toContainText(/Restored after reload|Reattached/);
  await expect(strip).toContainText("The new future is pending", { timeout: 90_000 });
  expect((await api<GL>("/api/generations")).generations.filter((g) => g.prompt === "slow refresh check")).toHaveLength(1);

  // Confirm keeps the runtime where it is.
  await select("slow refresh check");
  await insp.getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
  await expect(insp.getByText(/Engine confirmed/)).toBeVisible();
  await expect(page.getByText("Live · Original")).toBeVisible();
  await shot(page, "d07-end-of-workflow");

  expect(wall.blocked).toEqual([]);
  expect(new Set(wall.providers)).toEqual(new Set(["scripted"]));
  expect((await api<GL>("/api/generations")).generations.every((g) => g.provider === "scripted")).toBe(true);
  snapshotOfState = history(await api<TL>("/api/timelines"));
});

test("3. persistence across a clean quit and relaunch; new token, old one rejected", async ({ page, context }) => {
  const exited = await quit();
  expect(exited.every((p) => !alive(p))).toBe(true);
  await launch();
  const second = token();
  expect(second).not.toBe(firstToken);
  const after = await api<TL>("/api/timelines");
  expect(history(after)).toBe(snapshotOfState);
  expect((await fetch(`${ENGINE}/api/timelines/${after.active_timeline_id}/snapshots`, { method: "POST", headers: { Authorization: `Bearer ${firstToken}` } })).status).toBe(401);
  await firewall(context);
  await bind(page, second);
  await page.goto("/");
  await expect(page.getByText("Live · Original")).toBeVisible();
  await expect(page.locator(".future-node .future-select", { hasText: "Add a popular ranking" })).toHaveCount(1);
  await shot(page, "d08-after-relaunch");
});

test("4. crash of the shell mid-generation: engine stops, relaunch recovers", async () => {
  const tok = token();
  const tl = await api<TL>("/api/timelines");
  const started = await fetch(`${ENGINE}/api/generations`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, Origin: UI }, body: JSON.stringify({ parent_id: tl.active_timeline_id, prompt: "slow crash check", provider: "scripted" }) });
  expect(started.status).toBe(202);
  const id = ((await started.json()) as { id: string }).id;
  const exited = await crash();
  expect(exited.every((p) => !alive(p))).toBe(true);
  await launch();
  const record = await api<Gen>(`/api/generations/${id}`);
  expect(record.status).toBe("failed");
  expect(record.error?.message).toMatch(/Engine (restarted|stopped) before generation completed/);
  expect(record.timeline_id).toBeNull();
  const health = await api<{ status: string; runtime_running: boolean }>("/api/health");
  expect(health).toMatchObject({ status: "ok", runtime_running: true });
  expect(history(await api<TL>("/api/timelines"))).toBe(snapshotOfState);
  test.info().annotations.push({ type: "crash", description: `${record.status}: ${record.error?.message}` });
});

test("5. clean quit leaves nothing running", async () => {
  const pid = enginePid();
  const exited = await quit();
  expect(exited).toContain(pid);
  expect(exited.every((p) => !alive(p))).toBe(true);
});
