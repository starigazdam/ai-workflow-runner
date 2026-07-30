/**
 * Self-review gate — blocks PR creation unless self_review_completed is true.
 * Equivalent to peon/hooks/self-review-gate.sh.
 */
import type { Context } from "../context/ContextStore.js";
import type { GateResult } from "./types.js";

export function checkSelfReviewGate(context: Context): GateResult {
  const reviewed = context.self_review_completed === true;

  if (!reviewed) {
    return {
      ok: false,
      gateId: "self_review",
      reason: "Self-review not completed.",
      fixHint: `Set self_review_completed=true in context after reviewing the diff.`,
    };
  }

  return { ok: true, gateId: "self_review" };
}
