#!/usr/bin/env node
/**
 * Starts a throwaway Paradox engine for browser tests: fresh temp state dir,
 * scripted provider only, no Factory credentials, ephemeral runtime port.
 * Writes a lease file the spec uses to verify it is talking to THIS engine.
 * Started by playwright.config.ts; never point it at a shared state dir.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_ENGINE, E2E_STUDIO, leasePath } from "./target.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const python = join(repo, ".venv/bin/python");
const recipes = join(repo, "tests/fixtures/scripted_agent");
if (!existsSync(python)) throw new Error(`Isolated engine needs ${python}`);
if (!existsSync(recipes)) throw new Error(`Isolated engine needs scripted recipes at ${recipes}`);

const engine = new URL(E2E_ENGINE);
const studio = new URL(E2E_STUDIO);
/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sweep state left by runs that were killed before they could clean up.
const parent = join(tmpdir(), "paradox-e2e");
mkdirSync(parent, { recursive: true });
for (const name of readdirSync(parent)) {
  let owner = 0;
  try {
    owner = Number(readFileSync(join(parent, name, "owner.pid"), "utf8"));
  } catch {
    /* No owner file: an interrupted start. */
  }
  if (!owner || !alive(owner)) rmSync(join(parent, name), { recursive: true, force: true });
}
// This run replaces any previous lease for the port; a stale one must never vouch for it.
rmSync(leasePath(), { force: true });

const root = mkdtempSync(join(parent, "run-"));
writeFileSync(join(root, "owner.pid"), String(process.pid));
const state = join(root, "state");
const launcher = join(root, "launch.py");
writeFileSync(
  launcher,
  [
    "import os, sys",
    "from pathlib import Path",
    `sys.path.insert(0, ${JSON.stringify(repo)})`,
    "import uvicorn",
    "from engine.api import create_app",
    `uvicorn.run(create_app(state_dir=Path(os.environ["PARADOX_STATE_DIR"]), runtime_port=0), host=${JSON.stringify(engine.hostname)}, port=${Number(engine.port)}, log_level="warning")`,
    "",
  ].join("\n"),
);

// Only what the engine needs: no inherited API keys or tokens can enable a paid agent.
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? root,
  PARADOX_STATE_DIR: state,
  PARADOX_AGENT: "scripted",
  PARADOX_SCRIPTED_RECIPES: recipes,
  PARADOX_CORS_ORIGINS: `${studio.origin},http://127.0.0.1:${studio.port}`,
};

const child = spawn(python, ["-I", launcher], { cwd: root, env, stdio: "inherit" });
const lease = leasePath();
writeFileSync(lease, JSON.stringify({ base: E2E_ENGINE, pid: child.pid, launcher: process.pid, stateDir: state, startedAt: new Date().toISOString() }));

let closing = false;
/** @param {number} [code] */
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  child.once("exit", () => {
    rmSync(lease, { force: true });
    rmSync(root, { recursive: true, force: true });
    process.exit(code);
  });
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
child.on("exit", (code) => {
  if (closing) return;
  rmSync(lease, { force: true });
  rmSync(root, { recursive: true, force: true });
  process.exit(code ?? 1);
});
