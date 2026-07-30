/**
 * Wrapup gate — blocks /wrapup-session when isAutopilot is true.
 * Equivalent to peon/hooks/wrap-up-gate.sh.
 */
import type { GateResult } from "./types.js";

export function checkWrapupGate(
  prompt: string,
  isAutopilot: boolean,
): GateResult {
  const isWrapup = /\/wrapup-session|\/wrapup|wrapup/i.test(prompt);

  if (isWrapup && isAutopilot) {
    return {
      ok: false,
      gateId: "wrapup",
      reason: "Wrapup sessions require MANUAL confirmation.",
      fixHint:
        "User must explicitly invoke /wrapup-session in chat (not autopilot).",
    };
  }

  return { ok: true, gateId: "wrapup" };
}
