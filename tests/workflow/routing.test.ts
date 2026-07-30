import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  evaluateRouting,
} from "../../src/workflow/routing.js";

// =============================================================================
// evaluateCondition
// =============================================================================

describe("evaluateCondition", () => {
  it("matches 'contains' on nested path", () => {
    const ctx = { jira_data: { status: "In Analysis" } };
    expect(evaluateCondition("jira_data.status contains 'Analysis'", ctx)).toBe(
      true,
    );
  });

  it("rejects 'contains' when value is absent", () => {
    const ctx = { jira_data: { status: "In Progress" } };
    expect(evaluateCondition("jira_data.status contains 'Analysis'", ctx)).toBe(
      false,
    );
  });

  it("rejects 'contains' when path does not exist", () => {
    expect(evaluateCondition("jira_data.status contains 'X'", {})).toBe(false);
  });

  it("matches '==' on nested path", () => {
    const ctx = { jira_data: { issuetype: "Bug" } };
    expect(evaluateCondition("jira_data.issuetype == 'Bug'", ctx)).toBe(true);
  });

  it("rejects '==' when value differs", () => {
    const ctx = { jira_data: { issuetype: "Story" } };
    expect(evaluateCondition("jira_data.issuetype == 'Bug'", ctx)).toBe(false);
  });

  it("supports 'or' connective", () => {
    const ctx = { jira_data: { status: "QA Review" } };
    expect(
      evaluateCondition(
        "jira_data.status contains 'Review' or jira_data.status contains 'QA'",
        ctx,
      ),
    ).toBe(true);
  });

  it("fails 'or' when neither branch matches", () => {
    const ctx = { jira_data: { status: "In Progress" } };
    expect(
      evaluateCondition(
        "jira_data.status contains 'Review' or jira_data.status contains 'QA'",
        ctx,
      ),
    ).toBe(false);
  });

  it("returns false for unknown expression forms", () => {
    expect(evaluateCondition("something random", { something: "random" })).toBe(
      false,
    );
  });

  it("handles deeply nested paths", () => {
    const ctx = { a: { b: { c: { d: "yes" } } } };
    expect(evaluateCondition("a.b.c.d == 'yes'", ctx)).toBe(true);
  });

  it("handles non-string values for contains (returns false)", () => {
    const ctx = { jira_data: { status: 42 } };
    expect(evaluateCondition("jira_data.status contains '42'", ctx)).toBe(
      false,
    );
  });
});

// =============================================================================
// evaluateRouting
// =============================================================================

describe("evaluateRouting", () => {
  const rules: import("../../src/types/workflow.js").RoutingCondition[] = [
    {
      condition: "jira_data.status contains 'Analysis'",
      fork: ["analysis"],
      stop_after_fork: true,
    },
    {
      condition:
        "jira_data.status contains 'Review' or jira_data.status contains 'QA'",
      fork: ["pr_review", "pr_comment_fix"],
      stop_after_fork: false,
    },
    {
      condition: "jira_data.issuetype == 'Bug'",
      fork: ["planning", "bug_investigation"],
      stop_after_fork: false,
    },
  ];

  it("returns null when no conditions match", () => {
    const ctx = {
      jira_data: { status: "In Progress", issuetype: "Story" },
    };
    const result = evaluateRouting(rules, ctx, new Set());
    expect(result).toBeNull();
  });

  it("returns first matching fork", () => {
    const ctx = { jira_data: { status: "In Analysis", issuetype: "Task" } };
    const result = evaluateRouting(rules, ctx, new Set());
    expect(result).not.toBeNull();
    expect(result!.fork).toEqual(["analysis"]);
    expect(result!.stopAfterFork).toBe(true);
    expect(result!.index).toBe(0);
  });

  it("skips already-fired rules", () => {
    const ctx = { jira_data: { status: "In Analysis", issuetype: "Bug" } };
    // Rule 0 already fired — should match rule 2 (Bug)
    const result = evaluateRouting(rules, ctx, new Set([0]));
    expect(result).not.toBeNull();
    expect(result!.fork).toEqual(["planning", "bug_investigation"]);
    expect(result!.index).toBe(2);
  });

  it("matches review/QA rule", () => {
    const ctx = { jira_data: { status: "QA Review", issuetype: "Story" } };
    const result = evaluateRouting(rules, ctx, new Set());
    expect(result).not.toBeNull();
    expect(result!.fork).toEqual(["pr_review", "pr_comment_fix"]);
    expect(result!.stopAfterFork).toBe(false);
  });
});
