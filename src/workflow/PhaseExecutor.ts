/**
 * PhaseExecutor — runs a single workflow phase.
 *
 * Flow:
 *   1. Pre-gate: required_inputs check only (are prerequisites met?)
 *   2. Agent execution
 *   3. Post-gates: explicit gates from YAML (verify agent outputs, expression checks)
 *   4. Approval detection
 *   5. Retry loop: on post-gate failure, re-invoke agent with failure feedback (up to retry_limit)
 *
 * Does NOT merge outputs into context — the WorkflowEngine handles that.
 */
import type { PhaseDef } from "../types/workflow.js";
import type { Context } from "../context/ContextStore.js";
import type {
  AgentRunner,
  AgentRunResult,
  TokenUsage,
  WorkflowEventHandler,
} from "../agent/AgentRunner.js";
import type { GateResult } from "../gates/types.js";
import { checkArtifactGate } from "../gates/artifact-gate.js";
import { runGates, type GateRunnerOptions } from "../gates/GateRunner.js";

export interface PhaseResult {
  /** Outputs produced by the agent (may be non-empty even when approval is pending). */
  outputs: Partial<Context>;
  /** Gate evaluation results (pre + post, last attempt). */
  gateResults: GateResult[];
  /** Non-null if a blocking gate failed after all retry attempts. */
  blocked: GateResult | null;
  /** Non-null if a user_approval gate requires a pause. */
  approval: { gateId: string; message: string } | null;
  /** Model used for the agent call (for audit). */
  model?: string;
  /** Token usage from the agent call (last attempt). */
  usage?: TokenUsage;
  /** Number of retry attempts made (0 = first attempt succeeded or was blocked by pre-gate). */
  retries: number;
}

const DEFAULT_RETRY_LIMIT = 3;

/**
 * Execute a single phase: pre-gate → agent → post-gates → approval.
 * On post-gate failure, retries the agent with failure feedback appended (up to retry_limit).
 *
 * Pre-gate:  required_inputs only (context must already have these keys).
 * Post-gates: explicit gates from workflow.yaml (verify agent produced correct outputs).
 * Approval:  user_approval gates detected after agent ran.
 */
export async function executePhase(
  phase: PhaseDef,
  context: Readonly<Context>,
  runner: AgentRunner,
  gateOptions: GateRunnerOptions = {},
  onEvent?: WorkflowEventHandler,
): Promise<PhaseResult> {
  const allResults: GateResult[] = [];

  // 1. Pre-gate: required_inputs check (are prerequisites available?)
  if (phase.required_inputs.length > 0) {
    const preGate = checkArtifactGate(phase, context);
    allResults.push(preGate);
    if (!preGate.ok) {
      return {
        outputs: {},
        gateResults: allResults,
        blocked: preGate,
        approval: null,
        retries: 0,
      };
    }
  }

  const agentId = phase.agent ?? phase.id;
  const phaseMeta = {
    requiredInputs: phase.required_inputs,
    optionalInputs: phase.optional_inputs ?? [],
  };
  const maxAttempts = (phase.retry_limit ?? DEFAULT_RETRY_LIMIT) + 1;

  let lastAgentResult: AgentRunResult = { outputs: {}, model: phase.model };
  let lastBlocked: GateResult | null = null;
  let lastGateResults: GateResult[] = [];
  let retries = 0;

  // Build the user message for the current attempt, appending failure feedback on retries
  const buildContext = (
    attempt: number,
    prevFailure: GateResult | null,
  ): Readonly<Context> => {
    if (attempt === 0 || !prevFailure) return context;
    return {
      ...context,
      _retry_feedback: `Attempt ${attempt} failed gate "${prevFailure.gateId}": ${prevFailure.reason ?? "gate blocked"}. Fix your output and try again.`,
    } as Context;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      retries = attempt;
      onEvent?.({
        type: "phase_retry",
        phaseId: phase.id,
        attempt,
        maxAttempts,
        gateFailure:
          lastBlocked?.reason ?? lastBlocked?.gateId ?? "gate blocked",
      });
    }

    // 2. Run agent
    const attemptContext = buildContext(attempt, lastBlocked);
    const onDelta = onEvent
      ? (delta: string) =>
          onEvent({ type: "assistant_delta", phaseId: phase.id, delta })
      : undefined;
    lastAgentResult = await runner.run(
      agentId,
      phase.id,
      attemptContext,
      phase.model,
      phaseMeta,
      onDelta,
    );

    // 3. Post-gates evaluated against merged context
    if (phase.gates.length > 0) {
      const postContext = { ...context, ...lastAgentResult.outputs };
      const { results: postResults, blocked } = runGates(
        phase,
        postContext,
        gateOptions,
      );
      lastGateResults = postResults;
      lastBlocked = blocked;
      if (blocked) {
        // Check if this is a user_approval gate — don't retry those
        if (
          blocked.gateId &&
          phase.gates.find(
            (g) => g.id === blocked!.gateId && g.kind === "user_approval",
          )
        ) {
          break;
        }
        // Retry if we have attempts remaining
        if (attempt < maxAttempts - 1) continue;
        // Out of attempts
        allResults.push(...lastGateResults);
        return {
          outputs: lastAgentResult.outputs,
          gateResults: allResults,
          blocked,
          approval: null,
          model: lastAgentResult.model,
          usage: lastAgentResult.usage,
          retries,
        };
      }
    } else {
      lastBlocked = null;
      lastGateResults = [];
    }

    // Gates passed — exit retry loop
    allResults.push(...lastGateResults);
    break;
  }

  // 4. Detect user_approval gate → signal pause (agent already ran)
  const approvalGate = phase.gates.find((g) => g.kind === "user_approval");
  if (approvalGate) {
    return {
      outputs: lastAgentResult.outputs,
      gateResults: allResults,
      blocked: null,
      approval: { gateId: approvalGate.id, message: approvalGate.message },
      model: lastAgentResult.model,
      usage: lastAgentResult.usage,
      retries,
    };
  }

  return {
    outputs: lastAgentResult.outputs,
    gateResults: allResults,
    blocked: lastBlocked,
    approval: null,
    model: lastAgentResult.model,
    usage: lastAgentResult.usage,
    retries,
  };
}
