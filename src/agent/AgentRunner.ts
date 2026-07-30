/**
 * AgentRunner — abstraction for executing an agent within a workflow phase.
 * Implementations can dispatch to Copilot CLI, MCP, mock runners, etc.
 */
import type { Context } from "../context/ContextStore.js";
import type { GateResult } from "../gates/types.js";

/** Token usage stats from an LLM API call. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Summary of an agent execution. */
export interface AgentRunResult {
  /** Context keys produced by the agent. Merged into workflow context. */
  outputs: Partial<Context>;
  /** Optional logs/diagnostics from the agent run. */
  logs?: string[];
  /** Model used for this run (for audit/tracking). */
  model?: string;
  /** Token usage from the LLM call (if available). */
  usage?: TokenUsage;
}

/** Interface for running a named agent. Generic — works with any workflow. */
export interface AgentRunner {
  /**
   * Execute an agent by its ID (from workflow.yaml `agent` field).
   * @param agentId  Agent identifier (e.g. "05-intake", "30-implementer")
   * @param phaseId  Phase that triggered this execution (for logging/tracing)
   * @param context  Current workflow context (read-only; outputs are returned)
   * @param model    Model override from phase definition (optional)
   * @param phaseMeta Phase metadata for context filtering (optional)
   * @param onDelta  Streaming callback — called with each text delta chunk (optional)
   */
  run(
    agentId: string,
    phaseId: string,
    context: Readonly<Context>,
    model?: string,
    phaseMeta?: { requiredInputs?: string[]; optionalInputs?: string[] },
    onDelta?: (delta: string) => void,
  ): Promise<AgentRunResult>;
}

/** Events emitted by the WorkflowEngine during execution. */
export type WorkflowEvent =
  | { type: "phase_start"; phaseId: string; label: string; model?: string }
  | {
      type: "phase_complete";
      phaseId: string;
      outputKeys: string[];
      model?: string;
      usage?: TokenUsage;
    }
  | { type: "phase_skipped"; phaseId: string; reason: string }
  | { type: "gate_passed"; phaseId: string; gate: GateResult }
  | { type: "gate_blocked"; phaseId: string; gate: GateResult }
  | { type: "gate_advisory"; phaseId: string; gate: GateResult }
  | {
      type: "approval_required";
      phaseId: string;
      gateId: string;
      message: string;
    }
  | {
      type: "routing_fork";
      condition: string;
      targets: string[];
      stopAfterFork: boolean;
    }
  | {
      type: "loop_iteration";
      phaseId: string;
      index: number;
      total: number;
    }
  | {
      type: "phase_retry";
      phaseId: string;
      attempt: number;
      maxAttempts: number;
      gateFailure: string;
    }
  | {
      type: "workflow_complete";
      finalPhaseId: string;
      history: string[];
    }
  | { type: "workflow_error"; phaseId: string; error: string }
  | { type: "assistant_delta"; phaseId: string; delta: string };

export type WorkflowEventHandler = (event: WorkflowEvent) => void;
