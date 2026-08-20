import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @anthropic-ai/claude-agent-sdk BEFORE importing ClaudeSdkRunner.
// query() returns an async generator of SDK messages; mockQuery lets each
// test control exactly what messages are yielded, so no real API calls are
// ever made and no LLM fees are incurred.
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

import { ClaudeSdkRunner } from "../../src/agent/ClaudeSdkRunner.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build an async generator yielding the given SDK messages, mimicking query(). */
function fakeStream(messages: unknown[]): AsyncGenerator<unknown, void> {
  async function* gen() {
    for (const m of messages) yield m;
  }
  return gen();
}

/** A minimal successful "result" message carrying structured_output. */
function resultSuccess(opts: {
  structuredOutput?: unknown;
  usage?: { input_tokens: number; output_tokens: number };
  result?: string;
}) {
  return {
    type: "result",
    subtype: "success",
    result: opts.result ?? "",
    structured_output: opts.structuredOutput,
    usage: opts.usage ?? { input_tokens: 100, output_tokens: 50 },
  };
}

function resultError(subtype: string, result?: string) {
  return { type: "result", subtype, result };
}

function assistantText(text: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

function streamEventDelta(text: string) {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ClaudeSdkRunner", () => {
  const REPO_ROOT = "/tmp/fake-repo";

  beforeEach(() => {
    mockQuery.mockReset();
    // Suppress ANTHROPIC_API_KEY warning in tests
    process.env.ANTHROPIC_API_KEY = "test-key-for-unit-tests";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ── dry-run ────────────────────────────────────────────────────────────────

  describe("dry-run mode", () => {
    it("returns empty outputs with zero token usage", async () => {
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT, dryRun: true });
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

    it("does not call the Claude Agent SDK in dry-run", async () => {
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT, dryRun: true });
      await runner.run("05-intake", "intake", { ticket_id: "PROJ-1" });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("respects model override in dry-run", async () => {
      const runner = new ClaudeSdkRunner({
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

    it("works without ANTHROPIC_API_KEY set in dry-run", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT, dryRun: true });
      const result = await runner.run("05-intake", "intake", {});
      expect(result.outputs).toEqual({});
    });
  });

  // ── structured_output extraction ──────────────────────────────────────────

  describe("structured_output extraction", () => {
    it("uses structured_output from the result message when present", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([
          assistantText("Working on it..."),
          resultSuccess({
            structuredOutput: { analysis_done: true, ticket_summary: "Test" },
          }),
        ]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("05-intake", "intake", {});

      expect(result.outputs).toEqual({
        analysis_done: true,
        ticket_summary: "Test",
      });
    });

    it("populates TokenUsage from the result message usage field", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([
          resultSuccess({
            structuredOutput: { done: true },
            usage: { input_tokens: 1200, output_tokens: 300 },
          }),
        ]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.usage).toEqual({
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
      });
    });
  });

  // ── JSON text fallback ─────────────────────────────────────────────────────

  describe("JSON text fallback (no structured_output)", () => {
    it("extracts outputs from JSON code block in the final result text", async () => {
      const text = `Here are the outputs:\n\`\`\`json\n{"result": "ok", "count": 5}\n\`\`\``;
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ result: text })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({ result: "ok", count: 5 });
    });

    it("extracts outputs from bare JSON when no markdown fence", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([
          resultSuccess({ result: '{"output_key": "value123"}' }),
        ]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({ output_key: "value123" });
    });

    it("returns empty outputs when response is not parseable", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([
          resultSuccess({ result: "Thinking... let me analyze this phase." }),
        ]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({});
    });

    it("falls back to the last assistant text block when result.result is empty", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([
          assistantText('{"from_assistant_block": true}'),
          resultSuccess({ result: "" }),
        ]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({ from_assistant_block: true });
    });
  });

  // ── error result subtypes ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("logs an error and returns empty outputs on a non-success result subtype", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultError("error_max_turns", "Ran out of turns")]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      const result = await runner.run("30-implementer", "implement", {});

      expect(result.outputs).toEqual({});
      expect(result.logs?.some((l) => l.includes("error_max_turns"))).toBe(
        true,
      );
    });
  });

  // ── streaming deltas ───────────────────────────────────────────────────────

  describe("streaming via onDelta", () => {
    it("invokes onDelta for text_delta stream events", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([
          streamEventDelta("Hello "),
          streamEventDelta("world"),
          resultSuccess({ structuredOutput: { done: true } }),
        ]),
      );
      const deltas: string[] = [];
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run(
        "05-intake",
        "intake",
        {},
        undefined,
        undefined,
        (d) => deltas.push(d),
      );

      expect(deltas).toEqual(["Hello ", "world"]);
    });

    it("requests includePartialMessages only when onDelta is provided", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run("05-intake", "intake", {});

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { includePartialMessages?: boolean };
      };
      expect(callArgs.options.includePartialMessages).toBe(false);
    });
  });

  // ── call shape ─────────────────────────────────────────────────────────────

  describe("SDK call shape", () => {
    it("scopes tool access via cwd to repoRoot", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run("05-intake", "intake", {});

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { cwd?: string };
      };
      expect(callArgs.options.cwd).toBe(REPO_ROOT);
    });

    it("uses phase model override", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run("05-intake", "intake", {}, "claude-haiku-4-5");

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { model?: string };
      };
      expect(callArgs.options.model).toBe("claude-haiku-4-5");
    });

    it("defaults permissionMode to bypassPermissions", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run("05-intake", "intake", {});

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { permissionMode?: string };
      };
      expect(callArgs.options.permissionMode).toBe("bypassPermissions");
    });

    it("respects a custom permissionMode option", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({
        repoRoot: REPO_ROOT,
        permissionMode: "plan",
      });
      await runner.run("05-intake", "intake", {});

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { permissionMode?: string };
      };
      expect(callArgs.options.permissionMode).toBe("plan");
    });

    it("passes maxTurns through to the SDK options", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT, maxTurns: 5 });
      await runner.run("05-intake", "intake", {});

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { maxTurns?: number };
      };
      expect(callArgs.options.maxTurns).toBe(5);
    });
  });

  // ── context filtering via phaseMeta ───────────────────────────────────────

  describe("context filtering via phaseMeta", () => {
    it("sends only required_inputs keys in the prompt", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run(
        "30-implementer",
        "implement",
        { ticket_id: "PROJ-1", irrelevant_key: "noise", plan: "my plan" },
        undefined,
        { requiredInputs: ["ticket_id", "plan"] },
      );

      const callArgs = mockQuery.mock.calls[0][0] as { prompt: string };
      expect(callArgs.prompt).toContain("ticket_id");
      expect(callArgs.prompt).toContain("my plan");
      expect(callArgs.prompt).not.toContain("irrelevant_key");
    });

    it("sends full context when phaseMeta not provided", async () => {
      mockQuery.mockReturnValueOnce(
        fakeStream([resultSuccess({ structuredOutput: { done: true } })]),
      );
      const runner = new ClaudeSdkRunner({ repoRoot: REPO_ROOT });
      await runner.run("30-implementer", "implement", {
        key1: "a",
        key2: "b",
        key3: "c",
      });

      const callArgs = mockQuery.mock.calls[0][0] as { prompt: string };
      expect(callArgs.prompt).toContain("key1");
      expect(callArgs.prompt).toContain("key2");
      expect(callArgs.prompt).toContain("key3");
    });
  });
});
