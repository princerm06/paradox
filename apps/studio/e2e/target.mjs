/**
 * The one authorized target for mutating browser tests, shared by the
 * Playwright config, the isolated engine launcher, and the spec.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The shared engine (8000), its runtime (8001), and the everyday studio dev server (5173). */
const SHARED_PORTS = new Set(["8000", "8001", "5173"]);

/**
 * Normalize and validate a URL as an isolated, local test target. Throws with
 * the offending value; never returns a shared or remote target.
 * @param {string} value
 * @param {string} what
 * @returns {string} origin
 */
export function isolatedOrigin(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`E2E guard: ${what} "${value}" is not a URL.`);
  }
  if (url.protocol !== "http:") throw new Error(`E2E guard: ${what} ${url.href} must be plain http on loopback.`);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`E2E guard: ${what} ${url.href} is not a loopback host; refusing to mutate a remote engine.`);
  if (!url.port) throw new Error(`E2E guard: ${what} ${url.href} needs an explicit port.`);
  if (SHARED_PORTS.has(url.port)) throw new Error(`E2E guard: ${what} ${url.href} uses shared port ${url.port}; start the isolated engine instead.`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`E2E guard: ${what} ${url.href} must be a bare origin.`);
  return url.origin;
}

export const E2E_ENGINE = isolatedOrigin(process.env.PARADOX_E2E_ENGINE ?? "http://127.0.0.1:8010", "PARADOX_E2E_ENGINE");
export const E2E_STUDIO = isolatedOrigin(process.env.PARADOX_E2E_URL ?? "http://localhost:5174", "PARADOX_E2E_URL");

export function leasePath() {
  return join(tmpdir(), `paradox-e2e-lease-${new URL(E2E_ENGINE).port}.json`);
}
