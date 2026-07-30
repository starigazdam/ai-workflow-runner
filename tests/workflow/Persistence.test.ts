import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowEngine } from "../../src/workflow/WorkflowEngine.js";
import type { WorkflowSnapshot } from "../../src/workflow/WorkflowEngine.js";
import { MockAgentRunner } from "../../src/agent/MockAgentRunner.js";
import type { WorkflowDef } from "../../src/types/workflow.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal 3-phase linear workflow: phase_a → phase_b → phase_c (terminal). */
function threePhaseWorkflow(): WorkflowDef {
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
        id: "phase_a",
        label: "Phase A",
        agent: "agent-a",
        required_inputs: [],
        outputs: [{ key: "output_a" }],
        gates: [],
        next: "phase_b",
      },
      {
        id: "phase_b",
        label: "Phase B",
        agent: "agent-b",
        required_inputs: ["output_a"],
        outputs: [{ key: "output_b" }],
        gates: [],
        next: "phase_c",
      },
      {
        id: "phase_c",
        label: "Phase C",
        agent: "agent-c",
        required_inputs: ["output_b"],
        outputs: [{ key: "output_c" }],
        gates: [],
        terminal: true,
      },
    ],
  };
}

/** Create a unique temp dir for each test. */
function tempDir(label: string): string {
  const dir = join(tmpdir(), `peon-stage7-test-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRunner(outputs: Record<string, Record<string, unknown>> = {}) {
  const runner = new MockAgentRunner();
  for (const [phaseId, phaseOutputs] of Object.entries(outputs)) {
    runner.setPhaseOutput(phaseId, phaseOutputs);
  }
  return runner;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkflowEngine — snapshot persistence (Stage 7)", () => {
  // ── snapshot() includes phaseQueue / executed / routingFired ──────────────

  describe("extended snapshot fields", () => {
    it("snapshot() contains phaseQueue, executed, routingFired", async () => {
      const runner = makeRunner({
        phase_a: { output_a: "value_a" },
        phase_b: { output_b: "value_b" },
        phase_c: { output_c: "value_c" },
      });
      const engine = new WorkflowEngine({
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
      });
      const snap = await engine.run();

      expect(snap.phaseQueue).toBeDefined();
      expect(Array.isArray(snap.phaseQueue)).toBe(true);
      expect(snap.executed).toBeDefined();
      expect(Array.isArray(snap.executed)).toBe(true);
      expect(snap.routingFired).toBeDefined();
      expect(Array.isArray(snap.routingFired)).toBe(true);
    });

    it("completed snapshot has all 3 phases in executed", async () => {
      const runner = makeRunner({
        phase_a: { output_a: "a" },
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });
      const engine = new WorkflowEngine({
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
      });
      const snap = await engine.run();

      expect(snap.executed).toContain("phase_a");
      expect(snap.executed).toContain("phase_b");
      expect(snap.executed).toContain("phase_c");
      expect(snap.phaseQueue).toHaveLength(0);
    });
  });

  // ── snapshotDir: write snapshot.json to disk ───────────────────────────────

  describe("snapshotDir persistence", () => {
    it("writes snapshot.json after each phase when snapshotDir is set", async () => {
      const snapshotDir = tempDir("write-each-phase");
      const writtenAfterA = { captured: false };

      const runner = makeRunner({
        phase_a: { output_a: "a" },
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });
      const engine = new WorkflowEngine({
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
        snapshotDir,
        onEvent: (e) => {
          if (e.type === "phase_complete" && e.phaseId === "phase_a") {
            // Snapshot should already exist when phase_a completes
            writtenAfterA.captured = existsSync(
              join(snapshotDir, "snapshot.json"),
            );
          }
        },
      });

      await engine.run();

      expect(writtenAfterA.captured).toBe(true);
      expect(existsSync(join(snapshotDir, "snapshot.json"))).toBe(true);
    });

    it("snapshot.json contains required fields", async () => {
      const snapshotDir = tempDir("snapshot-fields");
      const runner = makeRunner({
        phase_a: { output_a: "a" },
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });
      const engine = new WorkflowEngine({
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
        snapshotDir,
      });

      await engine.run();

      const snap = JSON.parse(
        readFileSync(join(snapshotDir, "snapshot.json"), "utf-8"),
      ) as WorkflowSnapshot;
      expect(snap.state).toBe("completed");
      expect(Array.isArray(snap.history)).toBe(true);
      expect(Array.isArray(snap.executed)).toBe(true);
      expect(Array.isArray(snap.phaseQueue)).toBe(true);
      expect(Array.isArray(snap.routingFired)).toBe(true);
      expect(snap.context).toBeDefined();
    });

    it("does NOT crash when snapshotDir is not set", async () => {
      const runner = makeRunner({
        phase_a: { output_a: "a" },
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });
      // No snapshotDir — should run cleanly
      const engine = new WorkflowEngine({
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
      });
      const snap = await engine.run();
      expect(snap.state).toBe("completed");
    });
  });

  // ── WorkflowEngine.restore() ──────────────────────────────────────────────

  describe("WorkflowEngine.restore()", () => {
    it("restored engine finishes remaining phases — same final state as uninterrupted run", async () => {
      const workflow = threePhaseWorkflow();
      const runner1 = makeRunner({
        phase_a: { output_a: "from-a" },
        phase_b: { output_b: "from-b" },
        phase_c: { output_c: "from-c" },
      });

      // Run phase_a only — capture snapshot mid-flow
      let snapshotAfterA: WorkflowSnapshot | null = null;
      const engine1 = new WorkflowEngine({
        workflow,
        runner: runner1,
        autoApprove: true,
        onEvent: (e) => {
          if (e.type === "phase_complete" && e.phaseId === "phase_a") {
            snapshotAfterA = engine1.snapshot();
            // Force stop by making remaining phases return errors — we won't continue engine1;
            // we'll restore instead
          }
        },
      });

      // Run the full engine1 to get a reference final state
      const referenceSnap = await engine1.run();

      // Now simulate restore from the mid-point snapshot
      const runner2 = makeRunner({
        phase_b: { output_b: "from-b" },
        phase_c: { output_c: "from-c" },
      });

      // Manually craft an after-phase_a snapshot (phase_a done, b+c pending)
      const midSnap: WorkflowSnapshot = {
        state: "running",
        currentPhase: "phase_b",
        history: ["phase_a"],
        context: { output_a: "from-a" },
        phaseQueue: ["phase_b"],
        executed: ["phase_a"],
        routingFired: [],
      };

      const restoredEngine = WorkflowEngine.restore(midSnap, {
        workflow,
        runner: runner2,
        autoApprove: true,
      });

      const restoredSnap = await restoredEngine.resume();

      expect(restoredSnap.state).toBe("completed");
      expect(restoredSnap.history).toContain("phase_a");
      expect(restoredSnap.history).toContain("phase_b");
      expect(restoredSnap.history).toContain("phase_c");
      expect(restoredSnap.context.output_a).toBe("from-a");
      expect(restoredSnap.context.output_b).toBe("from-b");
      expect(restoredSnap.context.output_c).toBe("from-c");
      // Should match the reference run
      expect(restoredSnap.history).toEqual(referenceSnap.history);
    });

    it("restored engine preserves history from before the snapshot", async () => {
      const midSnap: WorkflowSnapshot = {
        state: "running",
        currentPhase: "phase_b",
        history: ["phase_a"],
        context: { output_a: "existing" },
        phaseQueue: ["phase_b"],
        executed: ["phase_a"],
        routingFired: [],
      };

      const runner = makeRunner({
        phase_b: { output_b: "b-result" },
        phase_c: { output_c: "c-result" },
      });

      const engine = WorkflowEngine.restore(midSnap, {
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
      });

      const snap = await engine.resume();

      // phase_a from before snapshot + phase_b + phase_c
      expect(snap.history[0]).toBe("phase_a");
      expect(snap.history).toHaveLength(3);
    });

    it("phase_a is NOT re-executed when restored after phase_a completed", async () => {
      let phaseACallCount = 0;
      const runner = makeRunner({
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });
      // Intercept phase_a to count calls
      const origRun = runner.run.bind(runner);
      runner.run = async (agentId, phaseId, ...rest) => {
        if (phaseId === "phase_a") phaseACallCount++;
        return origRun(agentId, phaseId, ...rest);
      };

      const midSnap: WorkflowSnapshot = {
        state: "running",
        currentPhase: "phase_b",
        history: ["phase_a"],
        context: { output_a: "pre-existing" },
        phaseQueue: ["phase_b"],
        executed: ["phase_a"],
        routingFired: [],
      };

      const engine = WorkflowEngine.restore(midSnap, {
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
      });

      await engine.resume();
      expect(phaseACallCount).toBe(0);
    });

    it("restore() throws if resume() called on non-running state", async () => {
      const completedSnap: WorkflowSnapshot = {
        state: "completed",
        currentPhase: null,
        history: ["phase_a", "phase_b", "phase_c"],
        context: {},
        phaseQueue: [],
        executed: ["phase_a", "phase_b", "phase_c"],
        routingFired: [],
      };

      const engine = WorkflowEngine.restore(completedSnap, {
        workflow: threePhaseWorkflow(),
        runner: makeRunner(),
        autoApprove: true,
      });

      await expect(engine.resume()).rejects.toThrow(
        /Cannot resume: engine is in 'completed'/,
      );
    });

    it("paused engine restored from snapshot can be approved", async () => {
      // Build a paused snapshot (approval required at phase_b)
      const pausedSnap: WorkflowSnapshot = {
        state: "paused",
        currentPhase: "phase_b",
        history: ["phase_a"],
        context: { output_a: "from-a" },
        phaseQueue: ["phase_b"],
        executed: ["phase_a"],
        routingFired: [],
        pendingApproval: {
          phaseId: "phase_a",
          gateId: "user_approval",
          message: "Please review before continuing",
        },
      };

      const runner = makeRunner({
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });

      const engine = WorkflowEngine.restore(pausedSnap, {
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
      });

      // In paused state — approve() should work
      const snap = await engine.approve();
      expect(snap.state).toBe("completed");
    });
  });

  // ── snapshot written on pause ─────────────────────────────────────────────

  describe("snapshot written on state transitions", () => {
    it("snapshot written to disk when workflow completes", async () => {
      const snapshotDir = tempDir("complete-snap");
      const runner = makeRunner({
        phase_a: { output_a: "a" },
        phase_b: { output_b: "b" },
        phase_c: { output_c: "c" },
      });
      const engine = new WorkflowEngine({
        workflow: threePhaseWorkflow(),
        runner,
        autoApprove: true,
        snapshotDir,
      });
      await engine.run();

      const snap = JSON.parse(
        readFileSync(join(snapshotDir, "snapshot.json"), "utf-8"),
      ) as WorkflowSnapshot;
      expect(snap.state).toBe("completed");
    });
  });
});
