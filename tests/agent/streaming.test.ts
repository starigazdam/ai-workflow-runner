/**
 * streaming.test.ts — tests for assistant_delta event emission through
 * WorkflowEngine + PhaseExecutor + MockAgentRunner.
 */
import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "../../src/workflow/WorkflowEngine.js";
import { MockAgentRunner } from "../../src/agent/MockAgentRunner.js";
import type { WorkflowDef } from "../../src/types/workflow.js";
import type { WorkflowEvent } from "../../src/agent/AgentRunner.js";

// ── Minimal 2-phase workflow for streaming tests ───────────────────────────

const WORKFLOW: WorkflowDef = {
  meta: {
    version: "1.0",
    context_file: "ctx.json",
    audit_dir: "audit/",
    artifacts_schema: "artifacts.json",
  },
  routing: [],
  phases: [
    {
      id: "phase_a",
      label: "Phase A",
      agent: "mock-agent",
      required_inputs: [],
      outputs: [],
      gates: [],
      next: "phase_b",
    },
    {
      id: "phase_b",
      label: "Phase B",
      agent: "mock-agent",
      required_inputs: [],
      outputs: [],
      gates: [],
      terminal: true,
    },
  ],
};

describe("streaming — assistant_delta events", () => {
  it("emits assistant_delta event when MockAgentRunner has delta configured", async () => {
    const runner = new MockAgentRunner();
    runner.setPhaseOutput("phase_a", { a_done: true });
    runner.setPhaseOutput("phase_b", { b_done: true });
    runner.setDelta("phase_a", "Hello from phase A");

    const events: WorkflowEvent[] = [];
    const engine = new WorkflowEngine({
      workflow: WORKFLOW,
      runner,
      autoApprove: true,
      onEvent: (e) => events.push(e),
    });

    await engine.run();

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      type: "assistant_delta",
      phaseId: "phase_a",
      delta: "Hello from phase A",
    });
  });

  it("emits delta only for phases that have delta configured", async () => {
    const runner = new MockAgentRunner();
    runner.setPhaseOutput("phase_a", { a_done: true });
    runner.setPhaseOutput("phase_b", { b_done: true });
    runner.setDelta("phase_b", "Phase B response text");
    // phase_a has no delta configured

    const events: WorkflowEvent[] = [];
    const engine = new WorkflowEngine({
      workflow: WORKFLOW,
      runner,
      autoApprove: true,
      onEvent: (e) => events.push(e),
    });

    await engine.run();

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ phaseId: "phase_b" });
  });

  it("emits delta events for both phases when both have deltas configured", async () => {
    const runner = new MockAgentRunner();
    runner.setPhaseOutput("phase_a", { a_done: true });
    runner.setPhaseOutput("phase_b", { b_done: true });
    runner.setDelta("phase_a", "A text");
    runner.setDelta("phase_b", "B text");

    const events: WorkflowEvent[] = [];
    const engine = new WorkflowEngine({
      workflow: WORKFLOW,
      runner,
      autoApprove: true,
      onEvent: (e) => events.push(e),
    });

    await engine.run();

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => (d as { delta: string }).delta)).toEqual([
      "A text",
      "B text",
    ]);
  });

  it("delta events appear between phase_start and phase_complete in event order", async () => {
    const runner = new MockAgentRunner();
    runner.setPhaseOutput("phase_a", { a_done: true });
    runner.setPhaseOutput("phase_b", { b_done: true });
    runner.setDelta("phase_a", "streaming text");

    const eventTypes: string[] = [];
    const engine = new WorkflowEngine({
      workflow: WORKFLOW,
      runner,
      autoApprove: true,
      onEvent: (e) => eventTypes.push(e.type),
    });

    await engine.run();

    const startIdx = eventTypes.indexOf("phase_start");
    const deltaIdx = eventTypes.indexOf("assistant_delta");
    const completeIdx = eventTypes.indexOf("phase_complete");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(startIdx);
    expect(completeIdx).toBeGreaterThan(deltaIdx);
  });

  it("no delta events emitted when no delta is configured", async () => {
    const runner = new MockAgentRunner();
    runner.setPhaseOutput("phase_a", { a_done: true });
    runner.setPhaseOutput("phase_b", { b_done: true });

    const events: WorkflowEvent[] = [];
    const engine = new WorkflowEngine({
      workflow: WORKFLOW,
      runner,
      autoApprove: true,
      onEvent: (e) => events.push(e),
    });

    await engine.run();

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(0);
  });

  it("reset() clears delta configuration", async () => {
    const runner = new MockAgentRunner();
    runner.setPhaseOutput("phase_a", { done: true });
    runner.setPhaseOutput("phase_b", { done: true });
    runner.setDelta("phase_a", "some text");
    runner.reset();
    runner.setPhaseOutput("phase_a", { done: true });
    runner.setPhaseOutput("phase_b", { done: true });
    // No delta configured after reset

    const events: WorkflowEvent[] = [];
    const engine = new WorkflowEngine({
      workflow: WORKFLOW,
      runner,
      autoApprove: true,
      onEvent: (e) => events.push(e),
    });

    await engine.run();

    const deltas = events.filter((e) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(0);
  });
});
