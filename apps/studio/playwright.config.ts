import { defineConfig } from "@playwright/test";
import { E2E_ENGINE, E2E_STUDIO } from "./e2e/target.mjs";

/**
 * Browser tests perform real mutations, so Playwright starts its own throwaway
 * engine (fresh temp state, scripted provider, no credentials) and a studio
 * dev server bound to it. Neither server is ever reused: if either port is
 * already taken the run fails instead of attaching to an unknown process.
 * The spec then verifies the browser's actual request target before mutating.
 * See README "Testing".
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  webServer: [
    {
      command: "node e2e/isolated-engine.mjs",
      url: `${E2E_ENGINE}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // SIGTERM lets the launcher stop the engine and delete its temp state and lease.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npx vite --port ${new URL(E2E_STUDIO).port} --strictPort`,
      url: E2E_STUDIO,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_PARADOX_API_BASE: E2E_ENGINE, VITE_PARADOX_SAFE_PROVIDER: "1" },
    },
  ],
  use: {
    baseURL: E2E_STUDIO,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "off",
  },
});
