import { describe, it, expect } from "vitest";
import {
  evaluateExpression,
  resolvePath,
} from "../../src/gates/expression-eval.js";

// =============================================================================
// resolvePath
// =============================================================================

describe("resolvePath", () => {
  it("resolves top-level key", () => {
    expect(resolvePath({ foo: "bar" }, "foo")).toBe("bar");
  });

  it("resolves nested path", () => {
    expect(resolvePath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing path", () => {
    expect(resolvePath({}, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for null intermediate", () => {
    expect(resolvePath({ a: null }, "a.b")).toBeUndefined();
  });

  it("resolves .length on array", () => {
    expect(resolvePath({ items: [1, 2, 3] }, "items.length")).toBe(3);
  });

  it("resolves .length on string", () => {
    expect(resolvePath({ name: "hello" }, "name.length")).toBe(5);
  });

  it("resolves nested .length", () => {
    expect(
      resolvePath({ plan: { subtasks: [1, 2] } }, "plan.subtasks.length"),
    ).toBe(2);
  });

  it("returns undefined for .length on number", () => {
    expect(resolvePath({ count: 5 }, "count.length")).toBeUndefined();
  });
});

// =============================================================================
// evaluateExpression — != null / == null
// =============================================================================

describe("evaluateExpression — null checks", () => {
  it("path != null passes when value exists", () => {
    expect(evaluateExpression("jira_data != null", { jira_data: {} })).toBe(
      true,
    );
  });

  it("path != null fails when value is null", () => {
    expect(evaluateExpression("jira_data != null", { jira_data: null })).toBe(
      false,
    );
  });

  it("path != null fails when value is undefined", () => {
    expect(evaluateExpression("jira_data != null", {})).toBe(false);
  });

  it("path != null fails when value is empty string", () => {
    expect(evaluateExpression("jira_data != null", { jira_data: "" })).toBe(
      false,
    );
  });

  it("nested path != null", () => {
    expect(
      evaluateExpression("jira_data.key != null", {
        jira_data: { key: "PROJ-1" },
      }),
    ).toBe(true);
  });

  it("nested path != null fails when nested is missing", () => {
    expect(evaluateExpression("jira_data.key != null", { jira_data: {} })).toBe(
      false,
    );
  });
});

// =============================================================================
// evaluateExpression — == comparisons
// =============================================================================

describe("evaluateExpression — equality", () => {
  it("path == true", () => {
    expect(
      evaluateExpression("verification_result.tests_passed == true", {
        verification_result: { tests_passed: true },
      }),
    ).toBe(true);
  });

  it("path == true fails when false", () => {
    expect(
      evaluateExpression("verification_result.tests_passed == true", {
        verification_result: { tests_passed: false },
      }),
    ).toBe(false);
  });

  it("path == true fails when string 'true'", () => {
    expect(
      evaluateExpression("self_review_completed == true", {
        self_review_completed: "true",
      }),
    ).toBe(false);
  });

  it("path == 0 (numeric)", () => {
    expect(
      evaluateExpression("security_report.critical.length == 0", {
        security_report: { critical: [] },
      }),
    ).toBe(true);
  });

  it("path == 0 fails when non-zero", () => {
    expect(
      evaluateExpression("security_report.critical.length == 0", {
        security_report: { critical: ["vuln1"] },
      }),
    ).toBe(false);
  });
});

// =============================================================================
// evaluateExpression — numeric comparisons
// =============================================================================

describe("evaluateExpression — numeric comparisons", () => {
  it("path.length > 0 passes when array has items", () => {
    expect(
      evaluateExpression("repo_context.length > 0", {
        repo_context: [{ name: "repo" }],
      }),
    ).toBe(true);
  });

  it("path.length > 0 fails when array is empty", () => {
    expect(
      evaluateExpression("repo_context.length > 0", { repo_context: [] }),
    ).toBe(false);
  });

  it("path.length <= 4", () => {
    expect(
      evaluateExpression("plan.subtasks.length <= 4", {
        plan: { subtasks: [1, 2, 3] },
      }),
    ).toBe(true);
  });

  it("path.length <= 4 fails when 5", () => {
    expect(
      evaluateExpression("plan.subtasks.length <= 4", {
        plan: { subtasks: [1, 2, 3, 4, 5] },
      }),
    ).toBe(false);
  });

  it("path.length >= 1", () => {
    expect(
      evaluateExpression("commits.messages.length >= 1", {
        commits: { messages: ["msg"] },
      }),
    ).toBe(true);
  });
});

// =============================================================================
// evaluateExpression — matches (regex)
// =============================================================================

describe("evaluateExpression — regex matches", () => {
  it("matches valid branch name", () => {
    const expr = String.raw`plan.branch matches /^(feature|fix|hotfix|refactor)\/[A-Z]+-[0-9]+-[a-z0-9-]+$/`;
    expect(
      evaluateExpression(expr, {
        plan: { branch: "feature/COPEE-9310-add-customer-endpoint" },
      }),
    ).toBe(true);
  });

  it("rejects invalid branch name", () => {
    const expr = String.raw`plan.branch matches /^(feature|fix|hotfix|refactor)\/[A-Z]+-[0-9]+-[a-z0-9-]+$/`;
    expect(
      evaluateExpression(expr, {
        plan: { branch: "main" },
      }),
    ).toBe(false);
  });

  it("rejects when path is not a string", () => {
    expect(evaluateExpression("x matches /^ok$/", { x: 42 })).toBe(false);
  });

  it("rejects when path is missing", () => {
    expect(evaluateExpression("x matches /^ok$/", {})).toBe(false);
  });
});

// =============================================================================
// evaluateExpression — in [...]
// =============================================================================

describe("evaluateExpression — in operator", () => {
  it("matches value in list", () => {
    expect(
      evaluateExpression(
        "bug_investigation.classification in ['CODE_FIX','CONFIG_ISSUE','ESCALATE']",
        { bug_investigation: { classification: "CODE_FIX" } },
      ),
    ).toBe(true);
  });

  it("rejects value not in list", () => {
    expect(
      evaluateExpression(
        "bug_investigation.classification in ['CODE_FIX','CONFIG_ISSUE','ESCALATE']",
        { bug_investigation: { classification: "UNKNOWN" } },
      ),
    ).toBe(false);
  });

  it("rejects when path is missing", () => {
    expect(evaluateExpression("x in ['a','b']", {})).toBe(false);
  });
});

// =============================================================================
// evaluateExpression — && conjunction
// =============================================================================

describe("evaluateExpression — conjunction", () => {
  it("both sides true", () => {
    expect(
      evaluateExpression("jira_data != null && jira_data.key != null", {
        jira_data: { key: "X" },
      }),
    ).toBe(true);
  });

  it("first side fails", () => {
    expect(
      evaluateExpression("jira_data != null && jira_data.key != null", {}),
    ).toBe(false);
  });

  it("second side fails", () => {
    expect(
      evaluateExpression("jira_data != null && jira_data.key != null", {
        jira_data: {},
      }),
    ).toBe(false);
  });

  it("length check conjunction", () => {
    expect(
      evaluateExpression(
        "plan.subtasks.length > 0 && plan.subtasks.length <= 4",
        { plan: { subtasks: [1, 2] } },
      ),
    ).toBe(true);
  });

  it("length check conjunction fails when too many", () => {
    expect(
      evaluateExpression(
        "plan.subtasks.length > 0 && plan.subtasks.length <= 4",
        { plan: { subtasks: [1, 2, 3, 4, 5] } },
      ),
    ).toBe(false);
  });

  it("length check conjunction fails when empty", () => {
    expect(
      evaluateExpression(
        "plan.subtasks.length > 0 && plan.subtasks.length <= 4",
        { plan: { subtasks: [] } },
      ),
    ).toBe(false);
  });
});

// =============================================================================
// evaluateExpression — real workflow.yaml gates
// =============================================================================

describe("evaluateExpression — workflow.yaml gates (integration)", () => {
  const fullContext = {
    jira_data: {
      key: "PROJ-9999",
      status: "In Progress",
      issuetype: "Story",
    },
    repo_context: [{ name: "repo-a", branch: "feature/PROJ-9999-test" }],
    plan: {
      branch: "feature/COPEE-9999-add-endpoint",
      subtasks: [{ id: 1 }, { id: 2 }],
    },
    commits: { messages: ["PROJ-9999: add endpoint"], repos: ["repo-a"] },
    verification_result: { tests_passed: true, lint_passed: true },
    security_report: { critical: [], high: [], medium: [], low: [] },
    self_review_completed: true,
    pr_data: { pr_id: "12345", title: "PROJ-9999: add endpoint" },
    analysis_doc: { file_path: "/path/to/doc.md", summary: "Analysis" },
    bug_investigation: { classification: "CODE_FIX", hypothesis: "test" },
  };

  const gates = [
    "jira_data != null && jira_data.key != null",
    "repo_context != null && repo_context.length > 0",
    "analysis_doc != null && analysis_doc.file_path != null",
    "pr_data != null && pr_data.pr_id != null",
    "pr_data != null",
    "bug_investigation.classification in ['CODE_FIX','CONFIG_ISSUE','ESCALATE']",
    "plan.subtasks.length > 0 && plan.subtasks.length <= 4",
    String.raw`plan.branch matches /^(feature|fix|hotfix|refactor)\/[A-Z]+-[0-9]+-[a-z0-9-]+$/`,
    "commits.messages.length > 0",
    "verification_result.tests_passed == true",
    "verification_result.lint_passed == true",
    "security_report.critical.length == 0",
    "security_report.high.length == 0",
    "self_review_completed == true",
    "pr_data.pr_id != null",
  ];

  for (const gate of gates) {
    it(`passes: ${gate}`, () => {
      expect(evaluateExpression(gate, fullContext)).toBe(true);
    });
  }
});
