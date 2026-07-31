/**
 * @experimental This runner is experimental and not yet validated for production use.
 *
 * AnthropicRunner — agent runner backed by the Anthropic Messages API.
 *
 * Uses `tool_use` content blocks for structured output extraction instead
 * of relying on JSON markdown parsing. The runner injects a single
 * `write_outputs` tool; the model is instructed to call it with the phase
 * outputs as arguments.
 *
 * Config:
 *   - API key:  ANTHROPIC_API_KEY env var (required)
 *   - Model:    claude-sonnet-4-5 (default); override via LLM_MODEL or phase.model
 *
 * Per-phase model override via `model` field in workflow.yaml.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context/ContextStore.js";
import type { AgentRunner, AgentRunResult, TokenUsage } from "./AgentRunner.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";

export interface AnthropicRunnerOptions {
  /** Root of the copilot-michal repo (contains .github/agents/) */
  repoRoot: string;
  /** If true, skip LLM call — just log and return empty outputs */
  dryRun?: boolean;
  /** Model override (takes precedence over env vars) */
  model?: string;
  /** Called before each LLM call for logging */
  onAgentCall?: (
    agentId: string,
    systemPrompt: string,
    userMessage: string,
  ) => void;
}

export class AnthropicRunner implements AgentRunner {
  private readonly repoRoot: string;
  private readonly dryRun: boolean;
  private readonly defaultModel: string;
  private readonly client: Anthropic;
  private readonly onAgentCall: AnthropicRunnerOptions["onAgentCall"];

  constructor(options: AnthropicRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.dryRun = options.dryRun ?? false;
    this.defaultModel = options.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    this.onAgentCall = options.onAgentCall;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey && !this.dryRun) {
      console.warn(
        "⚠ ANTHROPIC_API_KEY is not set — use --dry-run or set ANTHROPIC_API_KEY",
      );
    }
    this.client = new Anthropic({ apiKey: apiKey ?? "dry-run" });
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
          `[dry-run] agent=${agentId} phase=${phaseId} model=${effectiveModel}`,
        ],
        model: effectiveModel,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    return this.callAnthropic(
      systemPrompt,
      userMessage,
      effectiveModel,
      onDelta,
    );
  }

  private loadAgentPrompt(agentId: string): string {
    const agentPath = join(this.repoRoot, ".github", "agents", `${agentId}.md`);
    if (!existsSync(agentPath)) {
      return `You are agent "${agentId}". Execute your phase and call the write_outputs tool with the keys this phase produces.`;
    }
    return readFileSync(agentPath, "utf-8");
  }

  private buildUserMessage(
    phaseId: string,
    context: Readonly<Context>,
    phaseMeta?: { requiredInputs?: string[]; optionalInputs?: string[] },
  ): string {
    // Filter context to only keys relevant to this phase
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
      "Execute this phase. Call the write_outputs tool with the keys this phase produces.",
    ].join("\n");
  }

  private async callAnthropic(
    systemPrompt: string,
    userMessage: string,
    model: string,
    onDelta?: (delta: string) => void,
  ): Promise<AgentRunResult> {
    // The write_outputs tool is the structured output channel for the agent.
    // It accepts any JSON object — the agent decides which keys to write.
    const tools: Anthropic.Tool[] = [
      {
        name: "write_outputs",
        description:
          "Write the phase outputs to the workflow context. Call this once with all outputs for this phase as a single JSON object.",
        input_schema: {
          type: "object" as const,
          properties: {
            outputs: {
              type: "object",
              description:
                "Key-value map of phase outputs to merge into the workflow context.",
              additionalProperties: true,
            },
          },
          required: ["outputs"],
        },
      },
    ];

    if (onDelta) {
      return this.callAnthropicStreaming(
        systemPrompt,
        userMessage,
        model,
        tools,
        onDelta,
      );
    }

    const response = await this.client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools,
      tool_choice: { type: "auto" },
    });

    const usage: TokenUsage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    // Extract outputs from tool_use blocks
    const outputs = this.extractOutputsFromToolUse(response.content);

    // Collect text blocks for logs
    const logs: string[] = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((b) => b.text);

    return { outputs, logs, model, usage };
  }

  private async callAnthropicStreaming(
    systemPrompt: string,
    userMessage: string,
    model: string,
    tools: Anthropic.Tool[],
    onDelta: (delta: string) => void,
  ): Promise<AgentRunResult> {
    const stream = this.client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools,
      tool_choice: { type: "auto" },
    });

    const deltaChunks: string[] = [];
    stream.on("text", (text) => {
      deltaChunks.push(text);
      onDelta(text);
    });

    const response = await stream.finalMessage();
    const usage: TokenUsage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    const outputs = this.extractOutputsFromToolUse(response.content);
    const textLogs = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((b) => b.text);

    return {
      outputs,
      logs: textLogs.length ? textLogs : deltaChunks,
      model,
      usage,
    };
  }

  /**
   * Extracts phase outputs from Anthropic tool_use content blocks.
   * Handles the `write_outputs` tool call; falls back to JSON text parsing.
   */
  private extractOutputsFromToolUse(
    content: Anthropic.ContentBlock[],
  ): Partial<Context> {
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "write_outputs") {
        const input = block.input as { outputs?: Record<string, unknown> };
        if (input.outputs && typeof input.outputs === "object") {
          return input.outputs as Partial<Context>;
        }
      }
    }

    // Fallback: try to extract JSON from any text block (same as OpenAiRunner)
    for (const block of content) {
      if (block.type === "text") {
        const jsonMatch = block.text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[1]) as Partial<Context>;
          } catch {
            // ignore
          }
        }
        try {
          return JSON.parse(block.text) as Partial<Context>;
        } catch {
          // ignore
        }
      }
    }

    return {};
  }
}
