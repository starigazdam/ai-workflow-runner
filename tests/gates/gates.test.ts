import { describe, it, expect } from "vitest";
import { checkArtifactGate } from "../../src/gates/artifact-gate.js";
import { checkSelfReviewGate } from "../../src/gates/self-review-gate.js";
import { checkWrapupGate } from "../../src/gates/wrapup-gate.js";
import { runGates } from "../../src/gates/GateRunner.js";
import type { PhaseDef } from "../../src/types/workflow.js";

// --- Helpers ---

function makePhase(overrides: Partial<PhaseDef> = {}): PhaseDef {
  return {
    id: "test_phase",
    label: "Test Phase",
    agent: "30-implementer",
    required_inputs: ["jira_data", "plan"],
    outputs: [],
    gates: [],
    ...overrides,
  };
}

// =============================================================================
// Artifact Gate
// =============================================================================

describe("artifact-gate", () => {
  it("passes when all required_inputs are present", () => {
    const phase = makePhase({ required_inputs: ["jira_data", "plan"] });
    const context = { jira_data: { key: "PROJ-1" }, plan: { subtasks: [] } };
    const result = checkArtifactGate(phase, context);
    expect(result.ok).toBe(true);
    expect(result.missing).toBeUndefined();
  });

  it("blocks when required_inputs are missing", () => {
    const phase = makePhase({ required_inputs: ["jira_data", "plan"] });
    const context = { jira_data: { key: "PROJ-1" } }; // plan missing
    const result = checkArtifactGate(phase, context);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["plan"]);
    expect(result.reason).toContain("plan");
  });

  it("blocks when required_input is null", () => {
    const phase = makePhase({ required_inputs: ["jira_data"] });
    const context = { jira_data: null };
    const result = checkArtifactGate(phase, context);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["jira_data"]);
  });

  it("blocks when required_input is empty string", () => {
    const phase = makePhase({ required_inputs: ["jira_data"] });
    const context = { jira_data: "" };
    const result = checkArtifactGate(phase, context);
    expect(result.ok).toBe(false);
  });

  it("passes with no required_inputs", () => {
    const phase = makePhase({ required_inputs: [] });
    const result = checkArtifactGate(phase, {});
    expect(result.ok).toBe(true);
  });

  it("reports all missing keys, not just the first", () => {
    const phase = makePhase({
      required_inputs: ["jira_data", "plan", "repo_context"],
    });
    const result = checkArtifactGate(phase, {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["jira_data", "plan", "repo_context"]);
  });
});

// =============================================================================
// Self-Review Gate
// =============================================================================

describe("self-review-gate", () => {
  it("passes when self_review_completed is true", () => {
    const result = checkSelfReviewGate({ self_review_completed: true });
    expect(result.ok).toBe(true);
  });

  it("blocks when self_review_completed is false", () => {
    const result = checkSelfReviewGate({ self_review_completed: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Self-review");
  });

  it("blocks when self_review_completed is missing", () => {
    const result = checkSelfReviewGate({});
    expect(result.ok).toBe(false);
  });

  it("blocks when self_review_completed is a truthy string (must be boolean true)", () => {
    const result = checkSelfReviewGate({ self_review_completed: "true" });
    expect(result.ok).toBe(false);
  });
});

// =============================================================================
// Wrapup Gate
// =============================================================================

describe("wrapup-gate", () => {
  it("passes for non-wrapup prompts even in autopilot", () => {
    const result = checkWrapupGate("/workflow PROJ-1234", true);
    expect(result.ok).toBe(true);
  });

  it("passes for wrapup prompt when not autopilot", () => {
    const result = checkWrapupGate("/wrapup-session", false);
    expect(result.ok).toBe(true);
  });

  it("blocks wrapup prompt in autopilot mode", () => {
    const result = checkWrapupGate("/wrapup-session", true);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("MANUAL");
  });

  it("blocks /wrapup variant in autopilot mode", () => {
    const result = checkWrapupGate("/wrapup", true);
    expect(result.ok).toBe(false);
  });

  it("blocks case-insensitive wrapup in autopilot", () => {
    const result = checkWrapupGate("Wrapup please", true);
    expect(result.ok).toBe(false);
  });
});

// =============================================================================
// GateRunner — integrated
// =============================================================================

describe("GateRunner", () => {
  it("runs artifact gate implicitly for phases with required_inputs", () => {
    const phase = makePhase({ required_inputs: ["jira_data"] });
    const { blocked } = runGates(phase, {});
    expect(blocked).not.toBeNull();
    expect(blocked!.missing).toEqual(["jira_data"]);
  });

  it("passes when context has all required keys", () => {
    const phase = makePhase({ required_inputs: ["jira_data"] });
    const { blocked } = runGates(phase, { jira_data: { key: "X" } });
    expect(blocked).toBeNull();
  });

  it("runs self_review gate when defined on phase", () => {
    const phase = makePhase({
      required_inputs: [],
      gates: [
        {
          id: "gate_self_review",
          type: "blocking" as const,
          message: "Self-review not done",
        },
      ],
    });
    const { blocked } = runGates(phase, { self_review_completed: false });
    expect(blocked).not.toBeNull();
    expect(blocked!.gateId).toBe("self_review");
  });

  it("runs wrapup gate when defined on phase", () => {
    const phase = makePhase({
      required_inputs: [],
      gates: [
        {
          id: "gate_wrapup",
          type: "blocking" as const,
          kind: "wrap_up_gate" as const,
          message: "Wrapup blocked",
        },
      ],
    });
    const { blocked } = runGates(
      phase,
      {},
      {
        prompt: "/wrapup-session",
        isAutopilot: true,
      },
    );
    expect(blocked).not.toBeNull();
    expect(blocked!.gateId).toBe("wrapup");
  });

  it("advisory gates do not block", () => {
    const phase = makePhase({
      required_inputs: [],
      gates: [
        {
          id: "gate_warn",
          type: "advisory" as const,
          check: "security_report.high.length == 0",
          message: "High vulns present",
        },
      ],
    });
    const { blocked, results } = runGates(phase, {});
    expect(blocked).toBeNull();
    expect(results.length).toBeGreaterThan(0);
  });

  it("user_approval gates pass through (state machine handles pause)", () => {
    const phase = makePhase({
      required_inputs: [],
      gates: [
        {
          id: "gate_user_confirm",
          type: "blocking" as const,
          kind: "user_approval" as const,
          message: "Confirm plan",
        },
      ],
    });
    const { blocked } = runGates(phase, {});
    expect(blocked).toBeNull();
  });
});
