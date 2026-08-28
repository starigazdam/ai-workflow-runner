/**
 * ClaudeSdkRunner — agentic runner backed by the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`).
 *
 * Unlike `AnthropicRunner` (raw Messages API, single request/response,
 * structured output only via a `write_outputs` tool call), this runner
 * drives each phase through the actual Claude Agent SDK `query()` loop —
 * giving agents a real agentic loop with file read/write/edit and bash
 * tools, scoped to `repoRoot`, the same tier as `CopilotSdkRunner` but
 * backed by Claude Code instead of the Copilot CLI.
 *
 * Config:
 *   - API key:  ANTHROPIC_API_KEY env var (required unless dryRun)
 *   - Model:    claude-sonnet-4-5 (default); override via LLM_MODEL or phase.model
 *
 * Tool access is scoped to `repoRoot` via the SDK's `cwd` option. Phase
 * outputs are still parsed from a JSON code block / structured_output
 * in the final result, matching the convention used by the other runners
 * so that WorkflowEngine/ContextStore don't need to know which runner
 * produced them.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "../context/ContextStore.js";
import type { AgentRunner, AgentRunResult, TokenUsage } from "./AgentRunner.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";

export interface ClaudeSdkRunnerOptions {
  /** Root of the repo the runner operates on (contains .github/agents/). */
  repoRoot: string;
  /** If true, skip the SDK call — just log and return empty outputs. */
  dryRun?: boolean;
  /** Model override (takes precedence over env vars). */
  model?: string;
  /**
   * Max agentic turns per phase (SDK round-trips). Prevents runaway loops.
   * Default: 20.
   */
  maxTurns?: number;
  /**
   * Permission mode passed to the SDK. Default: "bypassPermissions" so
   * phases can run unattended in a workflow (matches CopilotSdkRunner's
   * approveAll behavior). Set to "default" to require interactive approval
   * via a custom `canUseTool` handler (not wired up here).
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Called before each SDK call for logging. */
  onAgentCall?: (
    agentId: string,
    systemPrompt: string,
    userMessage: string,
  ) => void;
}

export class ClaudeSdkRunner implements AgentRunner {
  private readonly repoRoot: string;
  private readonly dryRun: boolean;
  private readonly defaultModel: string;
  private readonly maxTurns: number;
  private readonly permissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan";
  private readonly onAgentCall: ClaudeSdkRunnerOptions["onAgentCall"];

  constructor(options: ClaudeSdkRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.dryRun = options.dryRun ?? false;
    this.defaultModel = options.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTurns = options.maxTurns ?? 20;
    this.permissionMode = options.permissionMode ?? "bypassPermissions";
    this.onAgentCall = options.onAgentCall;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey && !this.dryRun) {
      console.warn(
        "⚠ ANTHROPIC_API_KEY is not set — use --dry-run or set ANTHROPIC_API_KEY",
      );
    }
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

    return this.callClaudeSdk(systemPrompt, userMessage, effectiveModel, onDelta);
  }

  private loadAgentPrompt(agentId: string): string {
    const agentPath = join(this.repoRoot, ".github", "agents", `${agentId}.md`);
    if (!existsSync(agentPath)) {
      return `You are agent "${agentId}". Execute your phase and return your outputs as a JSON code block with the keys this phase produces.`;
    }
    return readFileSync(agentPath, "utf-8");
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
      "Execute this phase using the tools available to you (file read/write/edit, bash) " +
        "scoped to the repository. When done, return your outputs as a JSON code block " +
        "with the keys this phase produces.",
    ].join("\n");
  }

  private async callClaudeSdk(
    systemPrompt: string,
    userMessage: string,
    model: string,
    onDelta?: (delta: string) => void,
  ): Promise<AgentRunResult> {
    const options: ClaudeSdkOptions = {
      cwd: this.repoRoot,
      systemPrompt,
      model,
      maxTurns: this.maxTurns,
      permissionMode: this.permissionMode,
      includePartialMessages: !!onDelta,
    };

    const stream = query({ prompt: userMessage, options });

    const logs: string[] = [];
    let finalText = "";
    let usage: TokenUsage | undefined;
    let structuredOutput: unknown;

    for await (const message of stream) {
      switch (message.type) {
        case "stream_event": {
          if (onDelta) {
            const event = message.event as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta" &&
              event.delta.text
            ) {
              onDelta(event.delta.text);
            }
          }
          break;
        }
        case "assistant": {
          const content = (
            message.message as { content?: Array<{ type: string; text?: string }> }
          ).content;
          if (content) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                logs.push(block.text);
                finalText = block.text;
              }
            }
          }
          break;
        }
        case "result": {
          if (message.subtype === "success") {
            const result = message as {
              result?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
              };
              structured_output?: unknown;
            };
            if (result.result) finalText = result.result;
            structuredOutput = result.structured_output;
            if (result.usage) {
              usage = {
                promptTokens: result.usage.input_tokens ?? 0,
                completionTokens: result.usage.output_tokens ?? 0,
                totalTokens:
                  (result.usage.input_tokens ?? 0) +
                  (result.usage.output_tokens ?? 0),
              };
            }
          } else {
            const errorResult = message as { result?: string; errors?: string[] };
            logs.push(
              `[error] result subtype=${message.subtype}: ${
                errorResult.result ?? errorResult.errors?.join("; ") ?? "unknown error"
              }`,
            );
          }
          break;
        }
        default:
          break;
      }
    }

    const outputs =
      (structuredOutput as Partial<Context> | undefined) ??
      this.extractOutputsFromText(finalText);

    return { outputs, logs, model, usage };
  }

  /** Extracts phase outputs from a JSON code block (or bare JSON) in the final text. */
  private extractOutputsFromText(text: string): Partial<Context> {
    if (!text) return {};
    const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as Partial<Context>;
      } catch {
        // fall through
      }
    }
    try {
      return JSON.parse(text) as Partial<Context>;
    } catch {
      return {};
    }
  }
}
