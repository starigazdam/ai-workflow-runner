/**
 * CopilotSdkRunner.test.ts — unit tests for the Copilot SDK runner.
 *
 * @github/copilot-sdk is mocked so tests run without a live Copilot CLI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CopilotSdkRunnerOptions } from "../../src/agent/CopilotSdkRunner.js";

// ── Mock @github/copilot-sdk ───────────────────────────────────────────────

const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSendAndWait = vi.fn();
const mockSessionOn = vi.fn();
const mockCreateSession = vi.fn();
const mockStop = vi.fn().mockResolvedValue([]);
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockAgentSelect = vi.fn().mockResolvedValue({
  agent: { name: "selected", displayName: "", description: "" },
});

vi.mock("@github/copilot-sdk", () => ({
  approveAll: vi.fn().mockReturnValue({ kind: "approved" }),
  CopilotClient: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    createSession: mockCreateSession,
  })),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSession(responseContent: string) {
  mockSessionOn.mockImplementation(() => {});
  mockSendAndWait.mockResolvedValue({
    data: { content: responseContent },
  });
  mockCreateSession.mockResolvedValue({
    on: mockSessionOn,
    sendAndWait: mockSendAndWait,
    disconnect: mockDisconnect,
    rpc: { agent: { select: mockAgentSelect } },
  });
}

async function makeRunner(
  overrides?: Partial<CopilotSdkRunnerOptions>,
): Promise<import("../../src/agent/CopilotSdkRunner.js").CopilotSdkRunner> {
  const { CopilotSdkRunner } =
    await import("../../src/agent/CopilotSdkRunner.js");
  return new CopilotSdkRunner({
    repoRoot: "/fake/repo",
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("CopilotSdkRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: unknown agent → fallback prompt
    // Set up a default session response
    makeSession('```json\n{"result": "ok"}\n```');
  });

  it("dry-run returns empty outputs without starting client", async () => {
    const runner = await makeRunner({ dryRun: true });
    const result = await runner.run("05-intake", "intake", {});
    expect(result.outputs).toEqual({});
    expect(result.logs?.[0]).toContain("[dry-run]");
    expect(result.logs?.[0]).toContain("agent=05-intake");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("dry-run includes model in log when phase specifies one", async () => {
    const runner = await makeRunner({ dryRun: true });
    const result = await runner.run("05-intake", "intake", {}, "gpt-5");
    expect(result.logs?.[0]).toContain("model=gpt-5");
    expect(result.model).toBe("gpt-5");
  });

  it("starts client lazily on first real run", async () => {
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {});
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("creates a session per phase and disconnects after", async () => {
    const runner = await makeRunner({ sessionMode: "per-phase" });
    await runner.run("05-intake", "intake", {});
    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it("persistent mode (default): reuses one session across all phases", async () => {
    makeSession('{"result":"ok"}');
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {});
    await runner.run("20-planner", "planning", {});
    // One session created, never disconnected mid-run
    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(mockDisconnect).not.toHaveBeenCalled();
    // Disconnect only on stop()
    await runner.stop();
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it("persistent mode: registers all agents via customAgents and activates the first one", async () => {
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {});
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // customAgents must be present (may be empty array if agents dir not found)
    expect(Array.isArray(sessionConfig.customAgents)).toBe(true);
    // agent param activates the first phase's agent
    expect(sessionConfig.agent).toBe("05-intake");
    // Only one session created across two runs
    const sentPrompt = (
      mockSendAndWait.mock.calls[0]?.[0] as { prompt: string }
    ).prompt;
    // User message is clean phase context — no agent instructions prefix
    expect(sentPrompt).not.toContain("# Agent Instructions");
    expect(sentPrompt).toContain("## Phase: intake");
  });

  it("persistent mode: calls rpc.agent.select() when switching agents between phases", async () => {
    makeSession('{"result":"ok"}');
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {});
    // First phase: agent set via SessionConfig — no rpc.agent.select yet
    expect(mockAgentSelect).not.toHaveBeenCalled();
    // Second phase: rpc.agent.select called to switch
    await runner.run("20-planner", "planning", {});
    expect(mockAgentSelect).toHaveBeenCalledOnce();
    expect(mockAgentSelect).toHaveBeenCalledWith({ name: "20-planner" });
    // Still one session
    expect(mockCreateSession).toHaveBeenCalledOnce();
  });

  it("per-phase mode: creates and disconnects a session for every phase", async () => {
    makeSession('{"result":"ok"}');
    const runner = await makeRunner({ sessionMode: "per-phase" });
    await runner.run("05-intake", "intake", {});
    await runner.run("20-planner", "planning", {});
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });

  it("per-phase mode: registers agent via customAgents and activates via agent param", async () => {
    makeSession('{"result":"ok"}');
    const runner = await makeRunner({ sessionMode: "per-phase" });
    await runner.run("05-intake", "intake", {});
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // SDK-native agent selection: customAgents contains the phase agent
    expect(Array.isArray(sessionConfig.customAgents)).toBe(true);
    const agents = sessionConfig.customAgents as Array<{ name: string }>;
    expect(agents.some((a) => a.name === "05-intake")).toBe(true);
    expect(sessionConfig.agent).toBe("05-intake");
    // No systemMessage — agent prompt is in customAgents
    expect(sessionConfig.systemMessage).toBeUndefined();
  });

  it("per-phase mode: user message contains only phase context, not agent instructions", async () => {
    const runner = await makeRunner({ sessionMode: "per-phase" });
    await runner.run("05-intake", "intake", {});
    const sentPrompt = (
      mockSendAndWait.mock.calls[0]?.[0] as { prompt: string }
    ).prompt;
    // Agent prompt is in customAgents, not in user message
    expect(sentPrompt).not.toContain("# Agent Instructions");
    expect(sentPrompt).toContain("## Phase: intake");
  });

  it("parses JSON code block from response as outputs", async () => {
    makeSession(
      '```json\n{"ticket_id": "PROJ-1234", "analysis_done": true}\n```',
    );
    const runner = await makeRunner();
    const result = await runner.run("05-intake", "intake", {});
    expect(result.outputs).toEqual({
      ticket_id: "PROJ-1234",
      analysis_done: true,
    });
  });

  it("passes model override to createSession config", async () => {
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {}, "claude-sonnet-4-5");
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sessionConfig.model).toBe("claude-sonnet-4-5");
  });

  it("uses defaultModel when no phase model provided", async () => {
    const runner = await makeRunner({ defaultModel: "gpt-5" });
    await runner.run("05-intake", "intake", {});
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sessionConfig.model).toBe("gpt-5");
  });

  it("passes provider config to createSession when specified", async () => {
    const runner = await makeRunner({
      provider: {
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-test",
      },
    });
    await runner.run("05-intake", "intake", {});
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sessionConfig.provider).toEqual({
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
    });
  });

  it("does not include provider in createSession when not specified", async () => {
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {});
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sessionConfig.provider).toBeUndefined();
  });

  it("per-phase mode: each session carries exactly one custom agent (the active one)", async () => {
    makeSession('{"result":"ok"}');
    const runner = await makeRunner({ sessionMode: "per-phase" });
    await runner.run("05-intake", "intake", {});
    await runner.run("20-planner", "planning", {});
    // Two sessions, each with their own customAgents list
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    const config0 = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const config1 = mockCreateSession.mock.calls[1]?.[0] as Record<
      string,
      unknown
    >;
    expect((config0.customAgents as Array<{ name: string }>)[0]?.name).toBe(
      "05-intake",
    );
    expect((config1.customAgents as Array<{ name: string }>)[0]?.name).toBe(
      "20-planner",
    );
  });

  it("emits deltas via onDelta callback when streaming", async () => {
    // Deltas are fired via session.on for real-time display.
    // sendAndWait return value is the authoritative full content for output parsing.
    mockSessionOn.mockImplementation(
      (
        event: string,
        handler: (e: { data: { deltaContent: string } }) => void,
      ) => {
        if (event === "assistant.message_delta") {
          // Simulate two delta chunks (display only — not used for output parsing)
          handler({ data: { deltaContent: "```json\n{" } });
          handler({ data: { deltaContent: '"done":true}\n```' } });
        }
      },
    );
    // sendAndWait provides the complete response (used for output parsing)
    mockSendAndWait.mockResolvedValue({
      data: { content: '```json\n{"done":true}\n```' },
    });

    const deltas: string[] = [];
    const runner = await makeRunner();
    const result = await runner.run(
      "05-intake",
      "intake",
      {},
      undefined,
      undefined,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(["```json\n{", '"done":true}\n```']);
    expect(result.outputs).toEqual({ done: true });

    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sessionConfig.streaming).toBe(true);
  });

  it("streaming=false when no onDelta provided", async () => {
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {});
    const sessionConfig = mockCreateSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sessionConfig.streaming).toBe(false);
  });

  it("stop() calls client.stop() and disconnects persistent session", async () => {
    const runner = await makeRunner();
    await runner.run("05-intake", "intake", {}); // trigger lazy start + create session
    await runner.stop();
    expect(mockDisconnect).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("stop() is a no-op before any run (client never started)", async () => {
    const runner = await makeRunner();
    await runner.stop(); // should not throw
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("usage is undefined (SDK does not expose token counts)", async () => {
    const runner = await makeRunner();
    const result = await runner.run("05-intake", "intake", {});
    expect(result.usage).toBeUndefined();
  });

  it("filters context to requiredInputs + optionalInputs when phaseMeta provided", async () => {
    const runner = await makeRunner();
    const fullContext = {
      ticket_id: "PROJ-1",
      branch: "feature/X",
      irrelevant_key: "should not appear",
    };
    await runner.run("05-intake", "intake", fullContext, undefined, {
      requiredInputs: ["ticket_id"],
      optionalInputs: ["branch"],
    });

    // The user message sent to sendAndWait should only contain ticket_id + branch
    const sentPrompt = (
      mockSendAndWait.mock.calls[0]?.[0] as { prompt: string }
    ).prompt;
    expect(sentPrompt).toContain("ticket_id");
    expect(sentPrompt).toContain("branch");
    expect(sentPrompt).not.toContain("irrelevant_key");
  });

  it("disconnects session even when sendAndWait throws (per-phase mode)", async () => {
    mockSendAndWait.mockRejectedValueOnce(new Error("CLI timeout"));
    const runner = await makeRunner({ sessionMode: "per-phase" });
    await expect(runner.run("05-intake", "intake", {})).rejects.toThrow(
      "CLI timeout",
    );
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });
});
