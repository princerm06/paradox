// Lifecycle helpers for the built Paradox.app (portable, engine bundled inside).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export const ENGINE = "http://127.0.0.1:8120";
export const UI = "http://localhost:5192";
export const APP = process.env.PARADOX_DESKTOP_APP ?? resolve(import.meta.dirname, "../src-tauri/target/release/bundle/macos/Paradox Droid Demo.app");
export const APP_ID = process.env.PARADOX_DESKTOP_ID ?? "dev.paradox.desktop.droid-demo";
export const DATA = join(homedir(), "Library/Application Support", APP_ID);
export const DUMMY_FACTORY_KEY = "offline-dummy-not-a-valid-factory-key";
const TEST_KEY_SERVICE = `paradox-offline-desktop-${randomUUID()}`;
let stateBackup: string | null = null;
let dummyKeyInstalled = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listener(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-tnP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    return out ? Number(out.split("\n")[0]) : null;
  } catch {
    return null;
  }
}
export const enginePid = () => listener(8120);
export const appPid = () => listener(5192);
export function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function children(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** The per-launch token, read from the engine process environment (same user). */
export function token(expectDummyKey = false): string {
  const pid = enginePid();
  if (!pid) throw new Error("desktop engine not running");
  const env = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const match = /PARADOX_TOKEN=([0-9a-f]{48})\b/.exec(env);
  if (!match) throw new Error("token not found in engine environment");
  if (expectDummyKey) {
    if (!env.includes(`FACTORY_API_KEY=${DUMMY_FACTORY_KEY}`)) throw new Error("expected only the test dummy credential");
  } else if (/FACTORY_API_KEY=/.test(env)) throw new Error("keyless test engine unexpectedly contains a credential");
  return match[1];
}
export function engineEnv(): string {
  return execFileSync("ps", ["eww", "-o", "command=", "-p", String(enginePid())], { encoding: "utf8" });
}

export async function launch(): Promise<void> {
  if (!existsSync(APP)) throw new Error(`build the app first: ${APP}`);
  if (enginePid() || appPid()) throw new Error("desktop ports already in use");
  const child = spawn(join(APP, "Contents/MacOS/paradox-desktop"), [], {
    env: {
      HOME: homedir(), USER: userInfo().username, TMPDIR: tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PARADOX_DEMO_KEY_SERVICE: TEST_KEY_SERVICE,
    },
    stdio: "ignore",
  });
  let launchError: Error | undefined;
  child.on("error", (error) => { launchError = error; });
  child.unref();
  for (let i = 0; i < 150; i++) {
    if (launchError) throw launchError;
    if (enginePid() && appPid()) {
      try {
        if ((await fetch(`${ENGINE}/api/health`)).ok && (await fetch(UI)).ok) return;
      } catch {
        /* starting */
      }
    }
    await sleep(200);
  }
  throw new Error("app did not start");
}

async function gone(pids: Array<number | null>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !alive(p)) && !enginePid() && !appPid()) return;
    await sleep(200);
  }
  throw new Error(`processes still alive: ${pids.filter(alive).join(",")}`);
}

/** Cmd-Q equivalent; returns the pids that had to exit. */
export async function quit(): Promise<number[]> {
  const e = enginePid(), a = appPid();
  const pids = [a, e, ...(e ? children(e) : [])].filter(Boolean) as number[];
  execFileSync("osascript", ["-e", `tell application id "${APP_ID}" to quit`]);
  await gone(pids);
  return pids;
}

/** Hard crash of the shell (not the engine). */
export async function crash(): Promise<number[]> {
  const e = enginePid(), a = appPid();
  const pids = [a, e, ...(e ? children(e) : [])].filter(Boolean) as number[];
  process.kill(a!, "SIGKILL");
  await gone(pids);
  return pids;
}

export function resetState() {
  if (enginePid() || appPid()) throw new Error("quit the app before resetting state");
  rmSync(DATA, { recursive: true, force: true });
}

export function preserveState() {
  if (enginePid() || appPid()) throw new Error("quit the demo app before offline verification");
  if (existsSync(DATA)) {
    if (!lstatSync(DATA).isDirectory() || lstatSync(DATA).isSymbolicLink()) throw new Error("refusing unsafe application state path");
  }
  stateBackup = mkdtempSync(join(tmpdir(), "paradox-desktop-test-state-"));
  if (existsSync(DATA)) {
    renameSync(DATA, join(stateBackup, "original"));
  }
}

export function restoreState() {
  if (!stateBackup) return;
  if (enginePid() || appPid()) throw new Error("cannot restore state while the test app is running");
  if (existsSync(DATA)) renameSync(DATA, join(stateBackup, "offline-test-state"));
  if (existsSync(join(stateBackup, "original"))) renameSync(join(stateBackup, "original"), DATA);
  stateBackup = null;
}

export function installDummyKey() {
  execFileSync("/usr/bin/security", ["add-generic-password", "-a", userInfo().username, "-s", TEST_KEY_SERVICE, "-w", DUMMY_FACTORY_KEY], { stdio: "pipe" });
  dummyKeyInstalled = true;
}

export function removeDummyKey() {
  if (dummyKeyInstalled) {
    execFileSync("/usr/bin/security", ["delete-generic-password", "-a", userInfo().username, "-s", TEST_KEY_SERVICE], { stdio: "pipe" });
    dummyKeyInstalled = false;
  }
}
