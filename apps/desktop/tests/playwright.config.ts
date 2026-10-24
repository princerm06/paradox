import { defineConfig } from "@playwright/test";
// Drives the studio exactly as the .app serves it (http://localhost:5190) against the
// engine the .app itself launched, in WebKit (the engine behind macOS WKWebView).
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { browserName: "webkit", baseURL: "http://localhost:5190", viewport: { width: 1440, height: 900 }, actionTimeout: 15_000 },
});
