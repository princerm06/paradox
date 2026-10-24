import type { Generation, GenerationStatus } from "../api/types.ts";

/** Statuses the frozen M2 contract defines as still working. */
export const ACTIVE_STATUSES: readonly GenerationStatus[] = ["queued", "preparing", "generating", "validating"];
export const TERMINAL_STATUSES: readonly GenerationStatus[] = ["succeeded", "failed", "cancelled"];

/** Fixed validation order from the M2 contract. Checks that never ran are omitted by the engine. */
export const CHECK_ORDER = ["agent", "guard", "compile", "tests", "boot", "smoke"] as const;

export type GenerationPhase = "active" | "succeeded" | "failed" | "cancelled" | "unknown";

/**
 * Classify a backend status. Anything outside the contract is "unknown": it is
 * neither shown as in-flight nor offered a cancel, so an unexpected value can
 * never masquerade as a running generation.
 */
export function generationPhase(status: string | null | undefined): GenerationPhase {
  if (status && (ACTIVE_STATUSES as readonly string[]).includes(status)) return "active";
  if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
  return "unknown";
}

export function isActiveGeneration(status: string | null | undefined): boolean {
  return generationPhase(status) === "active";
}

export type LifecycleStep = { id: GenerationStatus; label: string; state: "done" | "current" | "todo" | "failed" | "skipped" };

const STEP_LABELS: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing",
  generating: "Generating",
  validating: "Validating",
};

/**
 * Steps for the in-flight stepper, derived only from the backend status. A
 * terminal generation reports where it stopped; an unknown status lights no step.
 */
export function lifecycleSteps(generation: Pick<Generation, "status" | "error">): LifecycleStep[] {
  const order = ACTIVE_STATUSES;
  const phase = generationPhase(generation.status);
  const currentIndex = order.indexOf(generation.status as GenerationStatus);
  const stoppedIndex = (() => {
    if (phase !== "failed" && phase !== "cancelled") return -1;
    const stage = generation.error?.stage;
    if (stage === "prepare") return 1;
    if (stage === "agent") return 2;
    if (stage && ["guard", "compile", "tests", "boot", "smoke"].includes(stage)) return 3;
    return -1;
  })();
  return order.map((id, index) => {
    let state: LifecycleStep["state"] = "todo";
    if (phase === "succeeded") state = "done";
    else if (phase === "active") state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
    else if (phase === "failed" || phase === "cancelled") {
      if (stoppedIndex < 0) state = "skipped";
      else state = index < stoppedIndex ? "done" : index === stoppedIndex ? "failed" : "skipped";
    }
    return { id, label: STEP_LABELS[id], state };
  });
}
