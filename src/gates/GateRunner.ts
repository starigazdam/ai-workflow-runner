/**
 * GateRunner — dispatches gate checks by gate id from workflow.yaml.
 * Maps gate ids referenced in phase definitions to actual check functions.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { PhaseDef, GateDef } from "../types/workflow.js";
import type { Context } from "../context/ContextStore.js";
import type { GateResult } from "./types.js";
import { checkArtifactGate } from "./artifact-gate.js";
import { checkSelfReviewGate } from "./self-review-gate.js";
import { checkWrapupGate } from "./wrapup-gate.js";
import { evaluateExpression } from "./expression-eval.js";

export { type GateResult } from "./types.js";

export interface GateRunnerOptions {
  /** Current user prompt (needed by wrapup gate). */
  prompt?: string;
  /** Whether running in autopilot mode (needed by wrapup gate). */
  isAutopilot?: boolean;
  /** Workflow directory (for resolving script gate paths). */
  workflowDir?: string;
}

/**
 * Run all gates defined on a phase. Returns the first blocking failure,
 * or an ok result if all gates pass. Advisory gates emit warnings but don't block.
 */
export function runGates(
  phase: PhaseDef,
  context: Context,
  options: GateRunnerOptions = {},
): { results: GateResult[]; blocked: GateResult | null } {
  const results: GateResult[] = [];
  let blocked: GateResult | null = null;

  for (const gate of phase.gates) {
    const result = runSingleGate(gate, phase, context, options);
    results.push(result);

    if (!result.ok && gate.type === "blocking" && !blocked) {
      blocked = result;
    }
  }

  // Also run the implicit artifact gate (required_inputs check)
  // unless the phase explicitly lists an artifact-type gate already
  const hasExplicitArtifact = phase.gates.some(
    (g) => g.id.startsWith("gate_") && g.check?.includes("!= null") && !g.kind,
  );

  if (!hasExplicitArtifact && phase.required_inputs.length > 0) {
    const artifactResult = checkArtifactGate(phase, context);
    results.push(artifactResult);
    if (!artifactResult.ok && !blocked) {
      blocked = artifactResult;
    }
  }

  return { results, blocked };
}

function runSingleGate(
  gate: GateDef,
  phase: PhaseDef,
  context: Context,
  options: GateRunnerOptions,
): GateResult {
  // User approval gates are always "pending" — they pass in automated mode
  // but the state machine should pause and request approval
  if (gate.kind === "user_approval") {
    return {
      ok: true, // passed through; state machine handles approval pause separately
      gateId: gate.id,
    };
  }

  // Wrapup gate
  if (gate.kind === "wrap_up_gate") {
    return checkWrapupGate(options.prompt ?? "", options.isAutopilot ?? false);
  }

  // Self-review gate (detected by id convention)
  if (gate.id === "gate_self_review") {
    return checkSelfReviewGate(context);
  }

  // Script gate: run a shell script, exit 0 = pass, non-zero = fail
  if (gate.kind === "script" && gate.check && options.workflowDir) {
    return runScriptGate(gate, context, options.workflowDir);
  }

  // Expression-based gates: evaluate gate.check against context
  if (gate.check) {
    const ok = evaluateExpression(gate.check, context);
    if (!ok) {
      // Extract referenced keys for diagnostics
      const keyMatches = gate.check.match(/[a-zA-Z_]\w*(?:\.\w+)*/g) ?? [];
      const missing = keyMatches.filter((k) => {
        const val = context[k.split(".")[0]];
        return val === undefined || val === null;
      });
      return {
        ok: false,
        gateId: gate.id,
        reason: gate.message,
        fixHint: gate.remediation,
        missing: missing.length > 0 ? [...new Set(missing)] : undefined,
      };
    }
    return { ok: true, gateId: gate.id };
  }

  // No check expression and no special kind — pass through
  return { ok: true, gateId: gate.id };
}

/**
 * Run a script gate: execute a shell script with context as JSON on stdin.
 * Exit 0 = pass, non-zero = fail. stdout = reason on failure.
 */
function runScriptGate(
  gate: GateDef,
  context: Context,
  workflowDir: string,
): GateResult {
  const scriptPath = join(workflowDir, gate.check!);
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      gateId: gate.id,
      reason: `Script not found: ${gate.check}`,
      fixHint: `Create ${scriptPath}`,
    };
  }

  const cmd = scriptPath.endsWith(".js")
    ? `node "${scriptPath}"`
    : `bash "${scriptPath}"`;

  try {
    const stdout = execSync(cmd, {
      input: JSON.stringify(context),
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      ok: true,
      gateId: gate.id,
      reason: stdout.trim() || undefined,
    };
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    const reason =
      execErr.stdout?.trim() || execErr.stderr?.trim() || gate.message;
    return {
      ok: false,
      gateId: gate.id,
      reason,
      fixHint: gate.remediation,
    };
  }
}
