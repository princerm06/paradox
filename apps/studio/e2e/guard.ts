import { existsSync, readFileSync } from "node:fs";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { E2E_ENGINE, isolatedOrigin, leasePath } from "./target.mjs";

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

export type Firewall = {
  /** Every mutating request the browser attempted that the guard refused. */
  violations: string[];
  /** Bodies of every generation request that was allowed through. */
  generations: Array<Record<string, unknown>>;
};

/**
 * Proves the engine at E2E_ENGINE is the throwaway one Playwright just started:
 * the launcher's lease names it and is still running, and its state is fresh
 * (only the root timeline, no generations). A shared engine with real futures
 * fails here before the browser opens. Returns the origins mutations may reach.
 */
export async function verifyIsolatedEngine(request: APIRequestContext): Promise<string[]> {
  const lease = leasePath();
  if (!existsSync(lease)) throw new Error(`E2E guard: no isolated-engine lease at ${lease}. Run through \`npm run e2e\` so Playwright starts the engine.`);
  const info = JSON.parse(readFileSync(lease, "utf8")) as { base: string; pid: number };
  if (info.base !== E2E_ENGINE) throw new Error(`E2E guard: lease is for ${info.base}, but tests target ${E2E_ENGINE}.`);
  try {
    process.kill(info.pid, 0);
  } catch {
    throw new Error(`E2E guard: isolated engine process ${info.pid} from the lease is not running.`);
  }
  const health = await request.get(`${E2E_ENGINE}/api/health`);
  if (!health.ok()) throw new Error(`E2E guard: ${E2E_ENGINE}/api/health answered ${health.status()}.`);
  const list = (await (await request.get(`${E2E_ENGINE}/api/timelines`)).json()) as { timelines: Array<{ parent_id: string | null }>; app_url: string };
  const generations = (await (await request.get(`${E2E_ENGINE}/api/generations`)).json()) as { generations: unknown[] };
  if (list.timelines.length !== 1 || list.timelines[0].parent_id !== null || generations.generations.length !== 0) {
    throw new Error(
      `E2E guard: ${E2E_ENGINE} is not a fresh isolated engine (${list.timelines.length} timelines, ${generations.generations.length} generations). Refusing to mutate it.`,
    );
  }
  const agents = (await (await request.get(`${E2E_ENGINE}/api/agents`)).json()) as { default: string; providers: Array<{ id: string; available: boolean }> };
  if (agents.default !== "scripted" || !agents.providers.some((item) => item.id === "scripted" && item.available)) {
    throw new Error(`E2E guard: ${E2E_ENGINE} does not default to an available scripted provider (default ${agents.default}).`);
  }
  const allowed = [E2E_ENGINE];
  // The live app is served by the same engine (proxy) or its ephemeral runtime.
  const app = new URL(list.app_url).origin;
  if (app !== E2E_ENGINE) allowed.push(isolatedOrigin(app, "engine app_url"));
  return allowed;
}

/**
 * Network-level fail-closed guard for a browser context: any mutating request
 * to an origin other than the isolated engine is aborted and recorded, and so
 * is any generation request that does not explicitly ask for `scripted`.
 */
export async function installFirewall(context: BrowserContext, allowed: string[]): Promise<Firewall> {
  const firewall: Firewall = { violations: [], generations: [] };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method();
    if (READ_ONLY.has(method)) return route.continue();
    const url = new URL(request.url());
    if (!allowed.includes(url.origin)) {
      firewall.violations.push(`${method} ${url.href}: not the isolated engine ${E2E_ENGINE}`);
      return route.abort("blockedbyclient");
    }
    if (url.origin === E2E_ENGINE && url.pathname === "/api/generations") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      } catch {
        /* Unparseable bodies fail the provider check below. */
      }
      if (body.provider !== "scripted") {
        firewall.violations.push(`${method} ${url.href}: provider ${JSON.stringify(body.provider)} is not "scripted"`);
        return route.abort("blockedbyclient");
      }
      firewall.generations.push(body);
    }
    return route.continue();
  });
  return firewall;
}

/**
 * Reads the studio's real request target from the running page (the engine
 * the app bound its client to, after any Settings override in storage) and
 * fails unless it is exactly the isolated engine. Call before every mutation.
 */
export async function assertBrowserTarget(page: Page): Promise<void> {
  const seen = await page.evaluate(() => ({
    bound: document.documentElement.getAttribute("data-paradox-engine"),
    override: (() => {
      try {
        return localStorage.getItem("paradox.apiBase");
      } catch {
        return "unreadable";
      }
    })(),
  }));
  if (seen.bound !== E2E_ENGINE) {
    throw new Error(`E2E guard: the studio is bound to ${seen.bound ?? "no engine"} (data-paradox-engine), not the isolated engine ${E2E_ENGINE}. Settings override: ${seen.override ?? "none"}.`);
  }
  if (seen.override !== null && seen.override !== E2E_ENGINE) {
    throw new Error(`E2E guard: browser storage overrides the engine to ${seen.override}; expected none or ${E2E_ENGINE}.`);
  }
}
