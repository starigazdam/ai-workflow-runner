/**
 * @experimental This runner is experimental and not yet validated for production use.
 *
 * OpenAiRunner — real agent runner backed by any OpenAI-compatible /chat/completions API.
 *
 * Default config (zero env vars needed when using GitHub Copilot API):
 *   - Base URL: https://api.githubcopilot.com
 *   - API key:  resolved from `gh auth token` at startup
 *   - Model:    claude-sonnet-4 (Sonnet 4.6)
 *
 * Per-phase model override via `model` field in workflow.yaml.
 * Env var overrides: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL.
 *
 * Works with any OpenAI-compatible endpoint (GitHub Copilot, OpenAI, Azure OpenAI, etc.).
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { Context } from "../context/ContextStore.js";
import type { AgentRunner, AgentRunResult, TokenUsage } from "./AgentRunner.js";

const DEFAULT_BASE_URL = "https://api.githubcopilot.com";
const DEFAULT_MODEL = "claude-sonnet-4";

export interface OpenAiRunnerOptions {
  /** Root of the copilot-michal repo (contains .github/agents/) */
  repoRoot: string;
  /** If true, skip LLM call — just log and return empty outputs */
  dryRun?: boolean;
  /** LLM config overrides (takes precedence over env vars and auto-detect) */
  llm?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  /** Called before each LLM call for logging */
  onAgentCall?: (
    agentId: string,
    systemPrompt: string,
    userMessage: string,
  ) => void;
}

export class OpenAiRunner implements AgentRunner {
  private readonly repoRoot: string;
  private readonly dryRun: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly onAgentCall: OpenAiRunnerOptions["onAgentCall"];

  constructor(options: OpenAiRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.dryRun = options.dryRun ?? false;
    this.onAgentCall = options.onAgentCall;

    // Resolve config: explicit > env > auto-detect
    this.baseUrl =
      options.llm?.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL;
    this.defaultModel =
      options.llm?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    this.apiKey =
      options.llm?.apiKey ?? process.env.LLM_API_KEY ?? this.resolveGhToken();
  }

  /** Resolve API key from `gh auth token`. Returns empty string on failure. */
  private resolveGhToken(): string {
    if (this.dryRun) return "";
    try {
      return execSync("gh auth token", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      console.warn(
        "⚠ Could not resolve gh auth token — use --dry-run or set LLM_API_KEY",
      );
      return "";
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

    if (this.dryRun || !this.apiKey) {
      return {
        outputs: {},
        logs: [
          `[dry-run] agent=${agentId} phase=${phaseId} model=${effectiveModel}`,
        ],
        model: effectiveModel,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    const { content, usage } = await this.callLLM(
      systemPrompt,
      userMessage,
      effectiveModel,
      onDelta,
    );
    const outputs = this.parseOutputs(content);
    return { outputs, logs: [content], model: effectiveModel, usage };
  }

  private loadAgentPrompt(agentId: string): string {
    const agentPath = join(this.repoRoot, ".github", "agents", `${agentId}.md`);
    if (!existsSync(agentPath)) {
      return `You are agent "${agentId}". Execute your phase and return outputs as JSON.`;
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
      "Execute this phase. Return your outputs as a JSON code block with the keys this phase produces.",
    ].join("\n");
  }

  private async callLLM(
    systemPrompt: string,
    userMessage: string,
    model: string,
    onDelta?: (delta: string) => void,
  ): Promise<{ content: string; usage?: TokenUsage }> {
    if (onDelta) {
      return this.callLLMStreaming(systemPrompt, userMessage, model, onDelta);
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
    });

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
          usage?: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
          };
        };
        const content = data.choices[0]?.message?.content ?? "";
        const usage: TokenUsage | undefined = data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined;
        return { content, usage };
      }

      const resBody = await res.text();
      const retryable =
        res.status === 403 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxRetries - 1) {
        throw new Error(`LLM API error ${res.status}: ${resBody}`);
      }

      const delay = (attempt + 1) * 2000; // 2s, 4s
      console.warn(
        `⚠ LLM ${res.status} (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    throw new Error("LLM call failed after retries");
  }

  private async callLLMStreaming(
    systemPrompt: string,
    userMessage: string,
    model: string,
    onDelta: (delta: string) => void,
  ): Promise<{ content: string; usage?: TokenUsage }> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!res.ok || !res.body) {
      const resBody = await res.text();
      throw new Error(`LLM streaming API error ${res.status}: ${resBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let usage: TokenUsage | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string } }>;
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            };
          };
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            fullContent += delta;
            onDelta(delta);
          }
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }
        } catch {
          // Ignore malformed SSE lines
        }
      }
    }

    return { content: fullContent, usage };
  }

  private parseOutputs(response: string): Partial<Context> {
    // Extract JSON from markdown code block
    const jsonMatch = response.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as Partial<Context>;
      } catch {
        // Fall through
      }
    }
    // Try parsing the whole response as JSON
    try {
      return JSON.parse(response) as Partial<Context>;
    } catch {
      return {};
    }
  }
}
