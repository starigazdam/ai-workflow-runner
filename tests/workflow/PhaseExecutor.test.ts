import { describe, it, expect } from "vitest";
import { executePhase } from "../../src/workflow/PhaseExecutor.js";
import type { PhaseDef } from "../../src/types/workflow.js";
import type { Context } from "../../src/context/ContextStore.js";
import type {
  AgentRunResult,
  WorkflowEvent,
} from "../../src/agent/AgentRunner.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minimalPhase(overrides: Partial<PhaseDef> = {}): PhaseDef {
  return {
    id: "test-phase",
    label: "Test Phase",
    agent: "test-agent",
    required_inputs: [],
    outputs: [],
    gates: [],
    ...overrides,
  };
}

function staticRunner(result: Partial<AgentRunResult>) {
  return {
    async run(): Promise<AgentRunResult> {
      return { outputs: {}, ...result };
    },
  };
}

// ─── Token usage ─────────────────────────────────────────────────────────────

describe("PhaseExecutor — token usage", () => {
  it("threads usage from AgentRunResult into PhaseResult", async () => {
    const runner = staticRunner({
      outputs: { foo: "bar" },
      model: "gpt-4",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const result = await executePhase(minimalPhase(), {}, runner);

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(result.model).toBe("gpt-4");
  });

  it("usage is undefined when runner does not provide it", async () => {
    const runner = staticRunner({ outputs: {} });
    const result = await executePhase(minimalPhase(), {}, runner);
    expect(result.usage).toBeUndefined();
  });
});

// ─── Context filtering (phaseMeta) ───────────────────────────────────────────

describe("PhaseExecutor — context filtering", () => {
  it("passes phaseMeta with required_inputs and optional_inputs to runner", async () => {
    const capturedMeta: {
      requiredInputs?: string[];
      optionalInputs?: string[];
    }[] = [];
    const runner = {
      async run(
        _agentId: string,
        _phaseId: string,
        _context: Readonly<Context>,
        _model?: string,
        phaseMeta?: { requiredInputs?: string[]; optionalInputs?: string[] },
      ): Promise<AgentRunResult> {
        if (phaseMeta) capturedMeta.push(phaseMeta);
        return { outputs: {} };
      },
    };

    const phase = minimalPhase({
      required_inputs: ["jira_data", "repo_context"],
      optional_inputs: ["bug_investigation"],
    });

    await executePhase(
      phase,
      { jira_data: {}, repo_context: {}, other: "x" },
      runner,
    );

    expect(capturedMeta).toHaveLength(1);
    expect(capturedMeta[0].requiredInputs).toEqual([
      "jira_data",
      "repo_context",
    ]);
    expect(capturedMeta[0].optionalInputs).toEqual(["bug_investigation"]);
  });
});

// ─── Retry loop ──────────────────────────────────────────────────────────────

describe("PhaseExecutor — retry loop", () => {
  it("retries on post-gate failure and succeeds on second attempt", async () => {
    let callCount = 0;
    const runner = {
      async run(): Promise<AgentRunResult> {
        callCount++;
        // First attempt: missing required output; second: correct
        if (callCount === 1) return { outputs: {} };
        return { outputs: { result: "ok" } };
      },
    };

    const phase = minimalPhase({
      required_inputs: [],
      gates: [
        {
          id: "gate_result_present",
          type: "blocking",
          check: "result != null",
          message: "result is missing",
        },
      ],
    });

    const events: WorkflowEvent[] = [];
    const result = await executePhase(phase, {}, runner, {}, (e) =>
      events.push(e),
    );

    expect(result.blocked).toBeNull();
    expect(result.outputs).toEqual({ result: "ok" });
    expect(result.retries).toBe(1);

    const retryEvents = events.filter((e) => e.type === "phase_retry");
    expect(retryEvents).toHaveLength(1);
    if (retryEvents[0].type === "phase_retry") {
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].phaseId).toBe("test-phase");
    }
  });

  it("blocks after max retries exhausted", async () => {
    const runner = staticRunner({ outputs: {} }); // always returns empty output

    const phase = minimalPhase({
      retry_limit: 2, // max 2 retries = 3 total attempts
      gates: [
        {
          id: "gate_requires_output",
          type: "blocking",
          check: "result != null",
          message: "result always missing",
        },
      ],
    });

    const events: WorkflowEvent[] = [];
    const result = await executePhase(phase, {}, runner, {}, (e) =>
      events.push(e),
    );

    expect(result.blocked).not.toBeNull();
    expect(result.blocked?.gateId).toBe("gate_requires_output");
    expect(result.retries).toBe(2); // 2 retries after initial attempt

    const retryEvents = events.filter((e) => e.type === "phase_retry");
    expect(retryEvents).toHaveLength(2);
  });

  it("does not retry when retry_limit is 0", async () => {
    let callCount = 0;
    const runner = {
      async run(): Promise<AgentRunResult> {
        callCount++;
        return { outputs: {} };
      },
    };

    const phase = minimalPhase({
      retry_limit: 0,
      gates: [
        {
          id: "gate_x",
          type: "blocking",
          check: "x != null",
          message: "x missing",
        },
      ],
    });

    const result = await executePhase(phase, {}, runner);

    expect(callCount).toBe(1); // no retries
    expect(result.blocked).not.toBeNull();
    expect(result.retries).toBe(0);
  });

  it("emits phase_retry with gate failure reason", async () => {
    let callCount = 0;
    const runner = {
      async run(): Promise<AgentRunResult> {
        callCount++;
        if (callCount < 3) return { outputs: {} };
        return { outputs: { value: "done" } };
      },
    };

    const phase = minimalPhase({
      retry_limit: 3,
      gates: [
        {
          id: "gate_value",
          type: "blocking",
          check: "value != null",
          message: "value not produced by agent",
          remediation: "ensure agent outputs value key",
        },
      ],
    });

    const events: WorkflowEvent[] = [];
    const result = await executePhase(phase, {}, runner, {}, (e) =>
      events.push(e),
    );

    expect(result.blocked).toBeNull();
    expect(result.retries).toBe(2);

    const retryEvents = events.filter((e) => e.type === "phase_retry");
    expect(retryEvents).toHaveLength(2);
    for (const e of retryEvents) {
      if (e.type === "phase_retry") {
        expect(e.gateFailure).toContain("value not produced by agent");
      }
    }
  });

  it("does not retry when pre-gate fails (missing required_inputs)", async () => {
    let callCount = 0;
    const runner = {
      async run(): Promise<AgentRunResult> {
        callCount++;
        return { outputs: {} };
      },
    };

    const phase = minimalPhase({
      required_inputs: ["prerequisite"],
      retry_limit: 3,
      gates: [],
    });

    const result = await executePhase(phase, {}, runner); // no prerequisite in context

    expect(callCount).toBe(0); // agent never called — blocked by pre-gate
    expect(result.blocked).not.toBeNull();
    expect(result.retries).toBe(0);
  });

  it("retries field is 0 when first attempt succeeds", async () => {
    const runner = staticRunner({ outputs: { value: "ok" } });

    const phase = minimalPhase({
      retry_limit: 3,
      gates: [
        {
          id: "gate_value",
          type: "blocking",
          check: "value != null",
          message: "value missing",
        },
      ],
    });

    const result = await executePhase(phase, {}, runner);

    expect(result.blocked).toBeNull();
    expect(result.retries).toBe(0);
  });
});

// ─── Token usage via WorkflowEngine events ─────────────────────────────────

describe("PhaseExecutor — usage in phase_complete event (via WorkflowEngine)", () => {
  it("phase_complete event carries usage when runner provides it", async () => {
    // Integration: verify WorkflowEngine threads usage through to phase_complete
    const { WorkflowEngine } =
      await import("../../src/workflow/WorkflowEngine.js");
    const { MockAgentRunner } =
      await import("../../src/agent/MockAgentRunner.js");

    const runner = new MockAgentRunner();
    runner.setPhaseOutput("alpha", { alpha_data: "x" });
    runner.setPhaseUsage("alpha", {
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
    });

    const events: WorkflowEvent[] = [];
    const engine = new WorkflowEngine({
      workflow: {
        meta: {
          version: "1.0",
          context_file: "ctx.json",
          audit_dir: "a/",
          artifacts_schema: "a.json",
        },
        routing: [],
        phases: [
          {
            id: "alpha",
            label: "Alpha",
            agent: "agent-alpha",
            required_inputs: [],
            outputs: [{ key: "alpha_data" }],
            gates: [],
            terminal: true,
          },
        ],
      },
      runner,
      autoApprove: true,
      onEvent: (e) => events.push(e),
    });

    await engine.run();

    const phaseComplete = events.find(
      (e): e is Extract<WorkflowEvent, { type: "phase_complete" }> =>
        e.type === "phase_complete" && e.phaseId === "alpha",
    );
    expect(phaseComplete).toBeDefined();
    expect(phaseComplete?.usage).toEqual({
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
    });
  });
});
