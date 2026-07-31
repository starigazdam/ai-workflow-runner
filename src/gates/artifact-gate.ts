/**
 * Artifact gate — validates that all required_inputs for a phase
 * exist and are non-null in the current context.
 * Equivalent to the SubagentStart artifact validation hook.
 */
import type { PhaseDef } from "../types/workflow.js";
import type { Context } from "../context/ContextStore.js";
import type { GateResult } from "./types.js";

export function checkArtifactGate(
  phase: PhaseDef,
  context: Context,
): GateResult {
  const missing: string[] = [];

  for (const key of phase.required_inputs) {
    const val = context[key];
    if (val === undefined || val === null || val === "") {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      gateId: `artifact:${phase.id}`,
      missing,
      reason: `Phase "${phase.id}" requires [${missing.join(", ")}] — not found in context.`,
      fixHint: `Write missing key(s) to context-{TICKET-ID}.json then retry.`,
    };
  }

  return { ok: true, gateId: `artifact:${phase.id}` };
}
