/**
 * MockAgentRunner — test double that returns preconfigured outputs per phase.
 */
import type { Context } from "../context/ContextStore.js";
import type { AgentRunner, AgentRunResult, TokenUsage } from "./AgentRunner.js";

export class MockAgentRunner implements AgentRunner {
  private phaseOutputs = new Map<string, Partial<Context>>();
  private phaseUsage = new Map<string, TokenUsage>();
  private phaseDeltas = new Map<string, string>();
  private callLog: Array<{ agentId: string; phaseId: string }> = [];

  /** Configure what a phase should return. */
  setPhaseOutput(phaseId: string, outputs: Partial<Context>): void {
    this.phaseOutputs.set(phaseId, outputs);
  }

  /** Configure token usage for a phase (for testing). */
  setPhaseUsage(phaseId: string, usage: TokenUsage): void {
    this.phaseUsage.set(phaseId, usage);
  }

  /** Configure streaming delta text for a phase (emitted when onDelta is provided). */
  setDelta(phaseId: string, delta: string): void {
    this.phaseDeltas.set(phaseId, delta);
  }

  /** Get the ordered call log for assertions. */
  getCalls(): ReadonlyArray<{ agentId: string; phaseId: string }> {
    return this.callLog;
  }

  /** Reset all configured outputs and call history. */
  reset(): void {
    this.phaseOutputs.clear();
    this.phaseUsage.clear();
    this.phaseDeltas.clear();
    this.callLog.length = 0;
  }

  async run(
    agentId: string,
    phaseId: string,
    _context: Readonly<Context>,
    model?: string,
    _phaseMeta?: { requiredInputs?: string[]; optionalInputs?: string[] },
    onDelta?: (delta: string) => void,
  ): Promise<AgentRunResult> {
    this.callLog.push({ agentId, phaseId });
    const outputs = this.phaseOutputs.get(phaseId) ?? {};
    const usage = this.phaseUsage.get(phaseId);
    const delta = this.phaseDeltas.get(phaseId);
    if (onDelta && delta !== undefined) {
      onDelta(delta);
    }
    return { outputs, model: model ?? "mock", usage };
  }
}
