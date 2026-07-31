import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @anthropic-ai/sdk BEFORE importing AnthropicRunner.
// vi.hoisted() ensures mockCreate is available in both the factory and tests.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

import { AnthropicRunner } from "../../src/agent/AnthropicRunner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Anthropic Messages API response with tool_use output. */
function makeToolUseResponse(
  outputs: Record<string, unknown>,
  usage = { input_tokens: 100, output_tokens: 50 },
) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    stop_reason: "tool_use",
    usage,
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "write_outputs",
        input: { outputs },
      },
    ],
  };
}

/** Build a minimal response with only a text block (no tool_use). */
function makeTextResponse(
  text: string,
  usage = { input_tokens: 80, output_tokens: 40 },
) {
  return {
    id: "msg_test_text",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    usage,
    content: [{ type: "text", text }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AnthropicRunner", () => {
  const REPO_ROOT = "/tmp/fake-repo";

  beforeEach(() => {
    mockCreate.mockReset();
    // Suppress ANTHROPIC_API_KEY warning in tests
    process.env.ANTHROPIC_API_KEY = "test-key-for-unit-tests";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ── dry-run ────────────────────────────────────────────────────────────────

  describe("dry-run mode", () => {
    it("returns empty outputs with zero token usage", async () => {
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT, dryRun: true });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({});
      expect(result.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
      expect(result.model).toBe("claude-sonnet-4-5");
      expect(result.logs?.[0]).toContain("[dry-run]");
    });

    it("does not call the Anthropic client in dry-run", async () => {
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT, dryRun: true });
      await runner.run("05-intake", "intake", { ticket_id: "PROJ-1" });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("respects model override in dry-run", async () => {
      const runner = new AnthropicRunner({
        repoRoot: REPO_ROOT,
        dryRun: true,
        model: "claude-haiku-4-5",
      });
      const result = await runner.run(
        "05-intake",
        "intake",
        {},
        "claude-opus-4-5",
      );
      // Phase-level model takes priority
      expect(result.model).toBe("claude-opus-4-5");
    });
  });

  // ── tool_use extraction ────────────────────────────────────────────────────

  describe("tool_use structured output", () => {
    it("extracts outputs from write_outputs tool_use block", async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolUseResponse({ analysis_done: true, ticket_summary: "Test" }),
      );
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("05-intake", "intake", {});

      expect(result.outputs).toEqual({
        analysis_done: true,
        ticket_summary: "Test",
      });
    });

    it("populates TokenUsage from Anthropic usage field", async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolUseResponse(
          { done: true },
          { input_tokens: 1200, output_tokens: 300 },
        ),
      );
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.usage).toEqual({
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
      });
    });

    it("handles nested object outputs from tool_use", async () => {
      const outputs = {
        plan: { subtasks: ["s1", "s2"], estimate: 3 },
        branch: "feature/PROJ-1-test",
      };
      mockCreate.mockResolvedValueOnce(makeToolUseResponse(outputs));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("20-planner", "plan", {});

      expect(result.outputs).toEqual(outputs);
    });
  });

  // ── text block fallback ────────────────────────────────────────────────────

  describe("text block fallback", () => {
    it("extracts outputs from JSON code block when no tool_use", async () => {
      const text = `Here are the outputs:\n\`\`\`json\n{"result": "ok", "count": 5}\n\`\`\``;
      mockCreate.mockResolvedValueOnce(makeTextResponse(text));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({ result: "ok", count: 5 });
    });

    it("extracts outputs from bare JSON when no markdown fence", async () => {
      mockCreate.mockResolvedValueOnce(
        makeTextResponse('{"output_key": "value123"}'),
      );
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({ output_key: "value123" });
    });

    it("returns empty outputs when response is not parseable", async () => {
      mockCreate.mockResolvedValueOnce(
        makeTextResponse("Thinking... let me analyze this phase."),
      );
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({});
    });

    it("captures text blocks in logs", async () => {
      const text = "Analysis complete.";
      mockCreate.mockResolvedValueOnce(makeTextResponse(text));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("05-intake", "intake", {});

      expect(result.logs).toContain(text);
    });
  });

  // ── context filtering via phaseMeta ───────────────────────────────────────

  describe("context filtering via phaseMeta", () => {
    it("sends only required_inputs keys to Anthropic", async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ done: true }));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      await runner.run(
        "30-implementer",
        "implement",
        { ticket_id: "PROJ-1", irrelevant_key: "noise", plan: "my plan" },
        undefined,
        { requiredInputs: ["ticket_id", "plan"] },
      );

      const callArgs = mockCreate.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMsg = callArgs.messages[0].content;
      expect(userMsg).toContain("ticket_id");
      expect(userMsg).toContain("my plan");
      expect(userMsg).not.toContain("irrelevant_key");
    });

    it("includes optional_inputs keys when present in context", async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ done: true }));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      await runner.run(
        "30-implementer",
        "implement",
        { ticket_id: "PROJ-1", optional_note: "useful", not_included: "x" },
        undefined,
        { requiredInputs: ["ticket_id"], optionalInputs: ["optional_note"] },
      );

      const callArgs = mockCreate.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMsg = callArgs.messages[0].content;
      expect(userMsg).toContain("optional_note");
      expect(userMsg).not.toContain("not_included");
    });

    it("sends full context when phaseMeta not provided", async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ done: true }));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      await runner.run("30-implementer", "implement", {
        key1: "a",
        key2: "b",
        key3: "c",
      });

      const callArgs = mockCreate.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMsg = callArgs.messages[0].content;
      expect(userMsg).toContain("key1");
      expect(userMsg).toContain("key2");
      expect(userMsg).toContain("key3");
    });
  });

  // ── tool_choice ────────────────────────────────────────────────────────────

  describe("API call shape", () => {
    it("sends write_outputs tool definition in messages.create call", async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ done: true }));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      await runner.run("05-intake", "intake", {});

      const callArgs = mockCreate.mock.calls[0][0] as {
        tools: Array<{ name: string }>;
      };
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools[0].name).toBe("write_outputs");
    });

    it("uses phase model override", async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ done: true }));
      const runner = new AnthropicRunner({ repoRoot: REPO_ROOT });
      await runner.run("05-intake", "intake", {}, "claude-haiku-4-5");

      const callArgs = mockCreate.mock.calls[0][0] as { model: string };
      expect(callArgs.model).toBe("claude-haiku-4-5");
    });
  });
});
