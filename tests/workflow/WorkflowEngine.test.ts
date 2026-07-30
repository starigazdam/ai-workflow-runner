import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowEngine } from "../../src/workflow/WorkflowEngine.js";
import { MockAgentRunner } from "../../src/agent/MockAgentRunner.js";
import type { WorkflowDef } from "../../src/types/workflow.js";
import type { WorkflowEvent } from "../../src/agent/AgentRunner.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal 3-phase linear workflow: alpha → beta → gamma (terminal). */
function linearWorkflow(): WorkflowDef {
  return {
    meta: {
      version: "1.0",
      context_file: "ctx.json",
      audit_dir: "audit/",
      artifacts_schema: "artifacts.json",
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
        next: "beta",
      },
      {
        id: "beta",
        label: "Beta",
        agent: "agent-beta",
        required_inputs: ["alpha_data"],
        outputs: [{ key: "beta_data" }],
        gates: [],
        next: "gamma",
      },
      {
        id: "gamma",
        label: "Gamma",
        agent: "agent-gamma",
        required_inputs: ["beta_data"],
        outputs: [],
        gates: [],
        terminal: true,
      },
    ],
  };
}

/** Workflow with routing: start → router, then fork to branch_a or default to main. */
function routingWorkflow(): WorkflowDef {
  return {
    meta: {
      version: "1.0",
      context_file: "ctx.json",
      audit_dir: "audit/",
      artifacts_schema: "artifacts.json",
    },
    routing: [
      {
        condition: "ticket.type == 'special'",
        fork: ["branch_a"],
        stop_after_fork: true,
      },
    ],
    phases: [
      {
        id: "start",
        label: "Start",
        agent: "agent-start",
        required_inputs: [],
        outputs: [{ key: "ticket" }],
        gates: [],
        next: "main",
      },
      {
        id: "main",
        label: "Main",
        agent: "agent-main",
        required_inputs: [],
        outputs: [],
        gates: [],
        terminal: true,
      },
      {
        id: "branch_a",
        label: "Branch A",
        agent: "agent-branch-a",
        required_inputs: [],
        outputs: [],
        gates: [],
        terminal: true,
      },
    ],
  };
}

/** Workflow with a user_approval gate on the second phase. */
function approvalWorkflow(): WorkflowDef {
  return {
    meta: {
      version: "1.0",
      context_file: "ctx.json",
      audit_dir: "audit/",
      artifacts_schema: "artifacts.json",
    },
    routing: [],
    phases: [
      {
        id: "prepare",
        label: "Prepare",
        agent: "agent-prep",
        required_inputs: [],
        outputs: [{ key: "plan" }],
        gates: [],
        next: "confirm",
      },
      {
        id: "confirm",
        label: "Confirm",
        agent: "agent-confirm",
        required_inputs: [],
        outputs: [{ key: "confirmed" }],
        gates: [
          {
            id: "gate_user_confirm",
            type: "blocking" as const,
            kind: "user_approval" as const,
            message: "Please confirm the plan.",
          },
        ],
        next: "execute",
      },
      {
        id: "execute",
        label: "Execute",
        agent: "agent-exec",
        required_inputs: ["confirmed"],
        outputs: [],
        gates: [],
        terminal: true,
      },
    ],
  };
}

/** Workflow where second phase has a required_input that blocks. */
function blockedWorkflow(): WorkflowDef {
  return {
    meta: {
      version: "1.0",
      context_file: "ctx.json",
      audit_dir: "audit/",
      artifacts_schema: "artifacts.json",
    },
    routing: [],
    phases: [
      {
        id: "first",
        label: "First",
        agent: "agent-first",
        required_inputs: [],
        outputs: [],
        gates: [],
        next: "second",
      },
      {
        id: "second",
        label: "Second",
        agent: "agent-second",
        required_inputs: ["missing_key"],
        outputs: [],
        gates: [],
        terminal: true,
      },
    ],
  };
}

/** Workflow with a routing fork that doesn't stop (continues to main after fork targets). */
function routingContinueWorkflow(): WorkflowDef {
  return {
    meta: {
      version: "1.0",
      context_file: "ctx.json",
      audit_dir: "audit/",
      artifacts_schema: "artifacts.json",
    },
    routing: [
      {
        condition: "ticket.type == 'review'",
        fork: ["review"],
        stop_after_fork: false,
      },
    ],
    phases: [
      {
        id: "start",
        label: "Start",
        agent: "agent-start",
        required_inputs: [],
        outputs: [{ key: "ticket" }],
        gates: [],
        next: "main",
      },
      {
        id: "review",
        label: "Review",
        agent: "agent-review",
        required_inputs: [],
        outputs: [{ key: "review_result" }],
        gates: [],
        next: "done",
      },
      {
        id: "main",
        label: "Main",
        agent: "agent-main",
        required_inputs: [],
        outputs: [],
        gates: [],
        terminal: true,
      },
      {
        id: "done",
        label: "Done",
        agent: "agent-done",
        required_inputs: [],
        outputs: [],
        gates: [],
        terminal: true,
      },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WorkflowEngine", () => {
  let runner: MockAgentRunner;
  let events: WorkflowEvent[];

  beforeEach(() => {
    runner = new MockAgentRunner();
    events = [];
  });

  function collectEvents(event: WorkflowEvent) {
    events.push(event);
  }

  // ── Linear workflow ─────────────────────────────────────────────────────

  describe("linear workflow", () => {
    it("runs all phases in order", async () => {
      runner.setPhaseOutput("alpha", { alpha_data: { id: 1 } });
      runner.setPhaseOutput("beta", { beta_data: { id: 2 } });
      runner.setPhaseOutput("gamma", {});

      const engine = new WorkflowEngine({
        workflow: linearWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual(["alpha", "beta", "gamma"]);
      expect(snap.context.alpha_data).toEqual({ id: 1 });
      expect(snap.context.beta_data).toEqual({ id: 2 });

      const calls = runner.getCalls();
      expect(calls.map((c) => c.phaseId)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("passes accumulated context to each agent", async () => {
      const capturedContexts: Record<string, unknown>[] = [];
      const customRunner = {
        async run(
          _agentId: string,
          phaseId: string,
          context: Record<string, unknown>,
        ) {
          capturedContexts.push({ ...context });
          if (phaseId === "alpha") return { outputs: { alpha_data: "a" } };
          if (phaseId === "beta") return { outputs: { beta_data: "b" } };
          return { outputs: {} };
        },
      };

      const engine = new WorkflowEngine({
        workflow: linearWorkflow(),
        runner: customRunner,
        onEvent: collectEvents,
      });

      await engine.run();

      // alpha sees empty context
      expect(capturedContexts[0]).toEqual({});
      // beta sees alpha's output
      expect(capturedContexts[1]).toEqual({ alpha_data: "a" });
      // gamma sees both
      expect(capturedContexts[2]).toEqual({
        alpha_data: "a",
        beta_data: "b",
      });
    });

    it("emits phase_start, phase_complete, and workflow_complete events", async () => {
      runner.setPhaseOutput("alpha", { alpha_data: "x" });
      runner.setPhaseOutput("beta", { beta_data: "y" });

      const engine = new WorkflowEngine({
        workflow: linearWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      await engine.run();

      const types = events.map((e) => e.type);
      expect(types).toContain("phase_start");
      expect(types).toContain("phase_complete");
      expect(types).toContain("workflow_complete");

      const complete = events.find((e) => e.type === "workflow_complete");
      expect(complete).toBeDefined();
      if (complete && complete.type === "workflow_complete") {
        expect(complete.history).toEqual(["alpha", "beta", "gamma"]);
      }
    });
  });

  // ── Routing ─────────────────────────────────────────────────────────────

  describe("routing", () => {
    it("follows routing fork when condition matches", async () => {
      runner.setPhaseOutput("start", { ticket: { type: "special" } });

      const engine = new WorkflowEngine({
        workflow: routingWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual(["start", "branch_a"]);
      expect(runner.getCalls().map((c) => c.phaseId)).toEqual([
        "start",
        "branch_a",
      ]);
    });

    it("follows default next when no routing matches", async () => {
      runner.setPhaseOutput("start", { ticket: { type: "normal" } });

      const engine = new WorkflowEngine({
        workflow: routingWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual(["start", "main"]);
    });

    it("emits routing_fork event", async () => {
      runner.setPhaseOutput("start", { ticket: { type: "special" } });

      const engine = new WorkflowEngine({
        workflow: routingWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      await engine.run();

      const fork = events.find((e) => e.type === "routing_fork");
      expect(fork).toBeDefined();
      if (fork && fork.type === "routing_fork") {
        expect(fork.targets).toEqual(["branch_a"]);
        expect(fork.stopAfterFork).toBe(true);
      }
    });

    it("follows fork target chain when stop_after_fork is false", async () => {
      runner.setPhaseOutput("start", { ticket: { type: "review" } });

      const engine = new WorkflowEngine({
        workflow: routingContinueWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      // Routing forks to review, which has next: done
      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual(["start", "review", "done"]);
    });
  });

  // ── Gate blocking ───────────────────────────────────────────────────────

  describe("gate blocking", () => {
    it("stops at a phase with unmet required_inputs", async () => {
      // first phase produces no outputs → second phase's required_input is missing
      runner.setPhaseOutput("first", {});

      const engine = new WorkflowEngine({
        workflow: blockedWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      expect(snap.state).toBe("blocked");
      expect(snap.history).toEqual(["first"]);
      expect(snap.blockedGate).toBeDefined();
      expect(snap.blockedGate!.phaseId).toBe("second");
    });

    it("emits gate_blocked event", async () => {
      runner.setPhaseOutput("first", {});

      const engine = new WorkflowEngine({
        workflow: blockedWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      await engine.run();

      const blocked = events.find((e) => e.type === "gate_blocked");
      expect(blocked).toBeDefined();
      if (blocked && blocked.type === "gate_blocked") {
        expect(blocked.phaseId).toBe("second");
      }
    });
  });

  // ── User approval ───────────────────────────────────────────────────────

  describe("user approval", () => {
    it("pauses at user_approval gate", async () => {
      runner.setPhaseOutput("prepare", { plan: { steps: 3 } });
      runner.setPhaseOutput("confirm", { confirmed: true });

      const engine = new WorkflowEngine({
        workflow: approvalWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      expect(snap.state).toBe("paused");
      expect(snap.history).toEqual(["prepare", "confirm"]);
      expect(snap.pendingApproval).toBeDefined();
      expect(snap.pendingApproval!.phaseId).toBe("confirm");
      expect(snap.pendingApproval!.message).toBe("Please confirm the plan.");
      // Agent DID run — outputs are in context
      expect(snap.context.confirmed).toBe(true);
    });

    it("resumes after approve()", async () => {
      runner.setPhaseOutput("prepare", { plan: { steps: 3 } });
      runner.setPhaseOutput("confirm", { confirmed: true });
      runner.setPhaseOutput("execute", {});

      const engine = new WorkflowEngine({
        workflow: approvalWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      await engine.run(); // pauses at confirm

      const snap = await engine.approve();

      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual(["prepare", "confirm", "execute"]);
    });

    it("errors on reject()", async () => {
      runner.setPhaseOutput("prepare", { plan: {} });
      runner.setPhaseOutput("confirm", { confirmed: true });

      const engine = new WorkflowEngine({
        workflow: approvalWorkflow(),
        runner,
        onEvent: collectEvents,
      });

      await engine.run(); // pauses

      const snap = await engine.reject("Not good enough");

      expect(snap.state).toBe("error");
      expect(snap.error).toBe("Not good enough");
    });

    it("skips approval in autoApprove mode", async () => {
      runner.setPhaseOutput("prepare", { plan: {} });
      runner.setPhaseOutput("confirm", { confirmed: true });
      runner.setPhaseOutput("execute", {});

      const engine = new WorkflowEngine({
        workflow: approvalWorkflow(),
        runner,
        autoApprove: true,
        onEvent: collectEvents,
      });

      const snap = await engine.run();

      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual(["prepare", "confirm", "execute"]);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty workflow (no phases)", async () => {
      const empty: WorkflowDef = {
        meta: {
          version: "1.0",
          context_file: "ctx.json",
          audit_dir: "audit/",
          artifacts_schema: "a.json",
        },
        routing: [],
        phases: [],
      };

      const engine = new WorkflowEngine({
        workflow: empty,
        runner,
        onEvent: collectEvents,
      });

      const snap = await engine.run();
      expect(snap.state).toBe("completed");
      expect(snap.history).toEqual([]);
    });

    it("throws when run() is called twice", async () => {
      const engine = new WorkflowEngine({
        workflow: linearWorkflow(),
        runner,
      });

      await engine.run();
      await expect(engine.run()).rejects.toThrow("Cannot run");
    });

    it("throws when approve() is called without pause", async () => {
      const engine = new WorkflowEngine({
        workflow: linearWorkflow(),
        runner,
      });

      await engine.run();
      await expect(engine.approve()).rejects.toThrow("Cannot approve");
    });

    it("uses initialContext", async () => {
      runner.setPhaseOutput("alpha", {});

      const engine = new WorkflowEngine({
        workflow: linearWorkflow(),
        runner,
        initialContext: {
          alpha_data: "preloaded",
          beta_data: "also_preloaded",
        },
        onEvent: collectEvents,
      });

      const snap = await engine.run();
      expect(snap.state).toBe("completed");
      // All phases ran — pre-existing context satisfied required_inputs
      expect(snap.history).toEqual(["alpha", "beta", "gamma"]);
    });

    it("snapshot() reflects current state", async () => {
      runner.setPhaseOutput("prepare", { plan: {} });
      runner.setPhaseOutput("confirm", { confirmed: true });

      const engine = new WorkflowEngine({
        workflow: approvalWorkflow(),
        runner,
      });

      const before = engine.snapshot();
      expect(before.state).toBe("idle");

      await engine.run();
      const after = engine.snapshot();
      expect(after.state).toBe("paused");
    });
  });
});

// ─── step() ─────────────────────────────────────────────────────────────────

describe("WorkflowEngine.step()", () => {
  let runner: MockAgentRunner;

  beforeEach(() => {
    runner = new MockAgentRunner();
    runner.setPhaseOutput("alpha", { alpha_data: "a" });
    runner.setPhaseOutput("beta", { beta_data: "b" });
    runner.setPhaseOutput("gamma", {});
  });

  it("runs one phase per call and stays running until depleted", async () => {
    const engine = new WorkflowEngine({ workflow: linearWorkflow(), runner });

    const s1 = await engine.step();
    expect(s1.state).toBe("running");
    expect(s1.history).toEqual(["alpha"]);
    expect(s1.currentPhase).toBe("beta");

    const s2 = await engine.step();
    expect(s2.state).toBe("running");
    expect(s2.history).toEqual(["alpha", "beta"]);
    expect(s2.currentPhase).toBe("gamma");

    const s3 = await engine.step();
    expect(s3.state).toBe("completed");
    expect(s3.history).toEqual(["alpha", "beta", "gamma"]);
  });

  it("transitions from idle on first call", async () => {
    const engine = new WorkflowEngine({ workflow: linearWorkflow(), runner });
    expect(engine.snapshot().state).toBe("idle");

    const snap = await engine.step();
    expect(snap.state).toBe("running");
    expect(snap.history).toEqual(["alpha"]);
  });

  it("throws when called on a completed engine", async () => {
    const engine = new WorkflowEngine({ workflow: linearWorkflow(), runner });
    await engine.step();
    await engine.step();
    await engine.step();

    await expect(engine.step()).rejects.toThrow("Cannot step");
  });

  it("pauses on user_approval gate and resumes with approve()", async () => {
    runner.setPhaseOutput("prepare", { plan: {} });
    runner.setPhaseOutput("confirm", { confirmed: true });
    runner.setPhaseOutput("execute", {});

    const engine = new WorkflowEngine({
      workflow: approvalWorkflow(),
      runner,
    });

    const s1 = await engine.step(); // runs 'prepare'
    expect(s1.state).toBe("running");
    expect(s1.history).toEqual(["prepare"]);

    const s2 = await engine.step(); // runs 'confirm' → hits user_approval gate
    expect(s2.state).toBe("paused");
    expect(s2.history).toEqual(["prepare", "confirm"]);
    expect(s2.pendingApproval).toBeDefined();

    const s3 = await engine.approve(); // resumes and runs remaining
    expect(s3.state).toBe("completed");
    expect(s3.history).toEqual(["prepare", "confirm", "execute"]);
  });

  it("accumulates context across steps", async () => {
    const engine = new WorkflowEngine({ workflow: linearWorkflow(), runner });

    await engine.step(); // alpha → {alpha_data: 'a'}
    const s2 = await engine.step(); // beta → {beta_data: 'b'}
    expect(s2.context).toMatchObject({ alpha_data: "a", beta_data: "b" });
  });

  it("does not rerun already-executed phases", async () => {
    const engine = new WorkflowEngine({ workflow: linearWorkflow(), runner });

    await engine.step(); // alpha
    await engine.step(); // beta
    // Manually re-queue alpha (simulates a hypothetical routing edge case)
    // step() must skip it because it's in executed set
    const snap = await engine.step(); // gamma (skips re-queued alpha)
    expect(snap.state).toBe("completed");
    expect(snap.history.filter((p) => p === "alpha")).toHaveLength(1);
  });

  it("emits phase_start and phase_complete events per step", async () => {
    const events: string[] = [];
    const engine = new WorkflowEngine({
      workflow: linearWorkflow(),
      runner,
      onEvent: (e) => events.push(e.type),
    });

    await engine.step();
    expect(events).toContain("phase_start");
    expect(events).toContain("phase_complete");
    // Only one phase worth of events
    expect(events.filter((e) => e === "phase_complete")).toHaveLength(1);
  });
});
