import type { AgentList } from "../api/types.ts";

/** Providers known to run without paid credits. Anything else is treated as paid. */
const FREE_PROVIDERS = new Set(["scripted"]);

export function isPaidProvider(id: string): boolean {
  return !FREE_PROVIDERS.has(id);
}

/**
 * Development builds start on the free scripted provider when the engine offers
 * it, so local testing never reaches a paid agent by default. Production builds
 * follow the engine's default. `VITE_PARADOX_SAFE_PROVIDER` ("1"/"0") overrides.
 */
export function prefersFreeProvider(): boolean {
  const flag = String(import.meta.env?.VITE_PARADOX_SAFE_PROVIDER ?? "");
  if (flag === "1") return true;
  if (flag === "0") return false;
  return Boolean(import.meta.env?.DEV);
}

/** The provider the composer starts on: never one the engine reports unavailable. */
export function initialProvider(list: AgentList, preferFree: boolean): string {
  const available = list.providers.filter((item) => item.available);
  if (preferFree) {
    const free = available.find((item) => !isPaidProvider(item.id));
    if (free) return free.id;
  }
  return (available.find((item) => item.id === list.default) ?? available[0])?.id ?? "";
}
