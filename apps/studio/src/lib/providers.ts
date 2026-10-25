import type { AgentList } from "../api/types.ts";

/** Providers known to run without paid credits. Anything else is treated as paid. */
const FREE_PROVIDERS = new Set(["scripted"]);

export function isPaidProvider(id: string): boolean {
  return !FREE_PROVIDERS.has(id);
}

/**
 * The provider the composer starts on, in every build: the free scripted
 * provider when the engine reports it available, otherwise none. The engine's
 * default is never adopted on its own, so a paid agent only runs after the user
 * picks it and confirms.
 */
export function initialProvider(list: AgentList): string {
  return list.providers.find((item) => item.available && !isPaidProvider(item.id))?.id ?? "";
}
