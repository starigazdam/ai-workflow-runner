/**
 * CopilotSdkRunner — primary agent runner backed by @github/copilot-sdk.
 *
 * Drives each phase through the real Copilot CLI, giving agents access to MCP
 * tools, file tools, and the full agentic loop — the original intent of this project.
 *
 * BYOK (bring-your-own-key) is supported via the `provider` option:
 *   - GitHub Copilot (default)  — omit `provider`
 *   - OpenAI / Azure OpenAI     — provider: { type: "openai"|"azure", baseUrl, apiKey }
 *   - Anthropic                 — provider: { type: "anthropic", baseUrl?, apiKey }
 *   - Ollama / local            — provider: { type: "openai", baseUrl: "http://localhost:11434/v1" }
 *
 * Session modes:
 *   - "persistent" (default) — one session per workflow run. All phases share conversation
 *     history. Agent .md instructions are injected per-message, not as system prompt.
 *   - "per-phase" — fresh session created and disconnected for every phase. Fully isolated.
 *
 * Agent selection:
 *   Uses SDK-native `customAgents` + `agent` in SessionConfig (available since SDK v0.2.2).
 *   Per-phase mode: each session carries exactly one CustomAgentConfig with the agent .md
 *   as `prompt`, and `agent` param activates it on creation.
 *   Persistent mode: first phase activates via `agent` in SessionConfig; subsequent phase
 *   switches call `session.rpc.agent.select({ name })` to swap the active agent.
 *
 * Note: Token usage is not exposed by the SDK — `usage` will be undefined.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import type { Context } from "../context/ContextStore.js";
import type { AgentRunner, AgentRunResult } from "./AgentRunner.js";

export interface ProviderConfig {
  type?: "openai" | "azure" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
}
export interface CopilotSdkRunnerOptions {
  /** Root of the copilot-michal repo (contains .github/agents/) */
  repoRoot: string;
  /** If true, skip CLI session — just log and return empty outputs */
  dryRun?: boolean;
  /** BYOK provider config. Omit to use GitHub Copilot (default). */
  provider?: ProviderConfig;
  /** Default model when phase doesn't specify one */
  defaultModel?: string;
  /**
   * Session lifecycle mode.
   * - "persistent" (default): one session per workflow run, all phases share history.
   *   Agent .md content is injected per user message, not as system prompt.
   * - "per-phase": fresh session per phase, fully isolated.
   */
  sessionMode?: "persistent" | "per-phase";
  /** Called before each session send for logging */
  onAgentCall?: (
    agentId: string,
    systemPrompt: string,
    userMessage: string,
  ) => void;
}

export class CopilotSdkRunner implements AgentRunner {
  private readonly repoRoot: string;
  private readonly dryRun: boolean;
  private readonly provider: ProviderConfig | undefined;
  private readonly defaultModel: string | undefined;
  private readonly sessionMode: "persistent" | "per-phase";
  private readonly onAgentCall: CopilotSdkRunnerOptions["onAgentCall"];
  private client: CopilotClient | null = null;
  /** Persistent session — only used when sessionMode === "persistent" */
  private persistentSession: CopilotSession | null = null;
  /** Agent ID active in the persistent session (for detecting switches) */
  private persistentSessionAgentId: string | null = null;

  constructor(options: CopilotSdkRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.dryRun = options.dryRun ?? false;
    this.provider = options.provider;
    this.defaultModel = options.defaultModel ?? process.env.LLM_MODEL;
    this.sessionMode = options.sessionMode ?? "persistent";
    this.onAgentCall = options.onAgentCall;
  }

  /** Start the Copilot CLI client. Called lazily on first phase. */
  async start(): Promise<void> {
    if (this.dryRun || this.client) return;
    this.client = new CopilotClient();
    await this.client.start();
  }

  /** Stop the Copilot CLI client (and disconnect persistent session if open). */
  async stop(): Promise<void> {
    if (this.persistentSession) {
      await this.persistentSession.disconnect();
      this.persistentSession = null;
      this.persistentSessionAgentId = null;
    }
    if (!this.client) return;
    await this.client.stop();
    this.client = null;
  }

  async run(
    agentId: string,
    phaseId: string,
    context: Readonly<Context>,
    model?: string,
    phaseMeta?: { requiredInputs?: string[]; optionalInputs?: string[] },
    onDelta?: (delta: string) => void,
  ): Promise<AgentRunResult> {
    const effectiveModel = model ?? this.defaultModel;
    const systemPrompt = this.loadAgentPrompt(agentId);
    const userMessage = this.buildUserMessage(phaseId, context, phaseMeta);

    this.onAgentCall?.(agentId, systemPrompt, userMessage);

    if (this.dryRun) {
      return {
        outputs: {},
        logs: [
          `[dry-run] agent=${agentId} phase=${phaseId}${effectiveModel ? ` model=${effectiveModel}` : ""}`,
        ],
        model: effectiveModel,
        usage: undefined,
      };
    }

    // Lazy start
    await this.start();
    if (!this.client) throw new Error("CopilotClient failed to start");

    return this.sessionMode === "persistent"
      ? this.runPersistent(
          agentId,
          systemPrompt,
          userMessage,
          effectiveModel,
          onDelta,
        )
      : this.runPerPhase(
          agentId,
          systemPrompt,
          userMessage,
          effectiveModel,
          onDelta,
        );
  }

  /**
   * Persistent mode: reuse one session across all phases.
   * All agents are pre-registered in `customAgents` at session creation so
   * rpc.agent.select() can switch to any of them mid-workflow.
   * First phase activates via `agent` in SessionConfig; subsequent switches
   * call `session.rpc.agent.select({ name })`.
   */
  private async runPersistent(
    agentId: string,
    _agentPrompt: string,
    phaseMessage: string,
    model: string | undefined,
    onDelta: ((delta: string) => void) | undefined,
  ): Promise<AgentRunResult> {
    if (!this.client) throw new Error("CopilotClient not started");

    // Create the persistent session on first phase
    if (!this.persistentSession) {
      // Pre-register ALL agents so rpc.agent.select() can switch to any of them
      const sessionConfig: SessionConfig = {
        onPermissionRequest: approveAll,
        streaming: !!onDelta,
        model,
        customAgents: this.loadAllAgents(),
        agent: agentId,
        provider: this.provider as SessionConfig["provider"],
      };
      this.persistentSession = await this.client.createSession(sessionConfig);
      this.persistentSessionAgentId = agentId;
    } else if (this.persistentSessionAgentId !== agentId) {
      // Switch to the new agent for this phase
      await this.persistentSession.rpc.agent.select({ name: agentId });
      this.persistentSessionAgentId = agentId;
    }

    return this.sendToSession(
      this.persistentSession,
      phaseMessage,
      model,
      onDelta,
      false, // don't disconnect — session is reused
    );
  }

  /**
   * Per-phase mode: create a fresh session for each phase, disconnect after.
   * Full isolation — no shared history between phases.
   * Agent is activated via `customAgents` + `agent` in SessionConfig.
   */
  private async runPerPhase(
    agentId: string,
    agentPrompt: string,
    userMessage: string,
    model: string | undefined,
    onDelta: ((delta: string) => void) | undefined,
  ): Promise<AgentRunResult> {
    if (!this.client) throw new Error("CopilotClient not started");

    const sessionConfig: SessionConfig = {
      onPermissionRequest: approveAll,
      streaming: !!onDelta,
      model,
      customAgents: [{ name: agentId, prompt: agentPrompt }],
      agent: agentId,
      provider: this.provider as SessionConfig["provider"],
    };

    const session = await this.client.createSession(sessionConfig);
    return this.sendToSession(session, userMessage, model, onDelta, true);
  }

  /** Send a message to a session, optionally disconnecting after. */
  private async sendToSession(
    session: CopilotSession,
    message: string,
    model: string | undefined,
    onDelta: ((delta: string) => void) | undefined,
    disconnectAfter: boolean,
  ): Promise<AgentRunResult> {
    let unsubscribeDelta: (() => void) | undefined;
    try {
      let fullContent = "";

      if (onDelta) {
        // Capture the unsubscribe fn so we remove this handler after the phase
        // completes. Without this, persistent sessions accumulate handlers and
        // deltas fire multiple times on subsequent phases.
        unsubscribeDelta = session.on("assistant.message_delta", (event) => {
          const delta = (event as { data?: { deltaContent?: string } }).data
            ?.deltaContent;
          if (delta) onDelta(delta);
        });
      }

      const result = await session.sendAndWait({ prompt: message });
      fullContent =
        (result as { data?: { content?: string } } | undefined)?.data
          ?.content ?? "";

      const outputs = this.parseOutputs(fullContent);
      return {
        outputs,
        logs: [fullContent],
        model,
        usage: undefined, // SDK doesn't expose token usage
      };
    } finally {
      unsubscribeDelta?.();
      if (disconnectAfter) await session.disconnect();
    }
  }

  private loadAgentPrompt(agentId: string): string {
    const agentPath = join(this.repoRoot, ".github", "agents", `${agentId}.md`);
    if (!existsSync(agentPath)) {
      return `You are agent "${agentId}". Execute your phase and return outputs as JSON.`;
    }
    return readFileSync(agentPath, "utf-8");
  }

  /**
   * Load all available agents from the agents directory.
   * Used in persistent mode to pre-register all agents in the session so
   * rpc.agent.select() can switch to any of them mid-workflow.
   */
  private loadAllAgents(): Array<{ name: string; prompt: string }> {
    const agentsDir = join(this.repoRoot, ".github", "agents");
    if (!existsSync(agentsDir)) return [];
    return readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: basename(f, ".md"),
        prompt: readFileSync(join(agentsDir, f), "utf-8"),
      }));
  }

  private buildUserMessage(
    phaseId: string,
    context: Readonly<Context>,
    phaseMeta?: { requiredInputs?: string[]; optionalInputs?: string[] },
  ): string {
    let filteredContext: Record<string, unknown>;
    if (phaseMeta?.requiredInputs || phaseMeta?.optionalInputs) {
      const allowedKeys = new Set([
        ...(phaseMeta.requiredInputs ?? []),
        ...(phaseMeta.optionalInputs ?? []),
      ]);
      filteredContext = {};
      for (const key of allowedKeys) {
        if (key in context) {
          filteredContext[key] = context[key];
        }
      }
    } else {
      filteredContext = { ...context };
    }

    return [
      `## Phase: ${phaseId}`,
      "",
      "## Current Context",
      "```json",
      JSON.stringify(filteredContext, null, 2),
      "```",
      "",
      "Execute this phase. Return your outputs as a JSON code block with the keys this phase produces.",
    ].join("\n");
  }

  private parseOutputs(response: string): Partial<Context> {
    const jsonMatch = response.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as Partial<Context>;
      } catch {
        // Fall through
      }
    }
    try {
      return JSON.parse(response) as Partial<Context>;
    } catch {
      return {};
    }
  }
}
