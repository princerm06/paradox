// Lifecycle helpers for the built Paradox.app (portable, engine bundled inside).
import { execFileSync, execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ENGINE = "http://127.0.0.1:8100";
export const UI = "http://localhost:5190";
export const APP = process.env.PARADOX_DESKTOP_APP ?? resolve(import.meta.dirname, "../src-tauri/target/release/bundle/macos/Paradox.app");
export const APP_ID = process.env.PARADOX_DESKTOP_ID ?? "dev.paradox.desktop";
export const DATA = join(homedir(), "Library/Application Support", APP_ID);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listener(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-tnP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    return out ? Number(out.split("\n")[0]) : null;
  } catch {
    return null;
  }
}
export const enginePid = () => listener(8100);
export const appPid = () => listener(5190);
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
export function token(): string {
  const pid = enginePid();
  if (!pid) throw new Error("desktop engine not running");
  const env = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const match = /PARADOX_TOKEN=([0-9a-f]{48})\b/.exec(env);
  if (!match) throw new Error("token not found in engine environment");
  if (/FACTORY_API_KEY=/.test(env)) throw new Error("engine environment contains FACTORY_API_KEY");
  return match[1];
}
export function engineEnv(): string {
  return execFileSync("ps", ["eww", "-o", "command=", "-p", String(enginePid())], { encoding: "utf8" });
}

export async function launch(): Promise<void> {
  if (!existsSync(APP)) throw new Error(`build the app first: ${APP}`);
  if (enginePid() || appPid()) throw new Error("desktop ports already in use");
  execFileSync("open", [APP]);
  for (let i = 0; i < 150; i++) {
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
