/**
 * pricing.ts — LLM cost estimation.
 *
 * Usage:
 *   const cost = calculateCost("claude-sonnet-4", { promptTokens: 1000, completionTokens: 500 });
 *   // → 0.0105  (USD)
 *
 * Pricing is approximate (April 2026) and used for audit/reporting only.
 * Unknown models return $0.00 — never throw.
 */
import type { TokenUsage } from "./AgentRunner.js";

export interface ModelPricing {
  /** USD per 1 million prompt tokens */
  promptPer1M: number;
  /** USD per 1 million completion tokens */
  completionPer1M: number;
}

/**
 * Pricing table — USD per 1M tokens.
 * Keys are matched by exact prefix so versioned variants (e.g. "claude-sonnet-4.6")
 * fall through to the base entry ("claude-sonnet-4").
 */
const PRICING: Record<string, ModelPricing> = {
  // Anthropic — Claude models
  "claude-opus-4": { promptPer1M: 15.0, completionPer1M: 75.0 },
  "claude-sonnet-4": { promptPer1M: 3.0, completionPer1M: 15.0 },
  "claude-haiku-4": { promptPer1M: 0.8, completionPer1M: 4.0 },
  "claude-opus-3": { promptPer1M: 15.0, completionPer1M: 75.0 },
  "claude-sonnet-3": { promptPer1M: 3.0, completionPer1M: 15.0 },
  "claude-haiku-3": { promptPer1M: 0.25, completionPer1M: 1.25 },
  // OpenAI
  "gpt-4o-mini": { promptPer1M: 0.15, completionPer1M: 0.6 },
  "gpt-4o": { promptPer1M: 2.5, completionPer1M: 10.0 },
  "gpt-4-turbo": { promptPer1M: 10.0, completionPer1M: 30.0 },
  "gpt-4": { promptPer1M: 30.0, completionPer1M: 60.0 },
  "gpt-3.5": { promptPer1M: 0.5, completionPer1M: 1.5 },
  "o1-mini": { promptPer1M: 1.1, completionPer1M: 4.4 },
  "o1-pro": { promptPer1M: 150.0, completionPer1M: 600.0 },
  o1: { promptPer1M: 15.0, completionPer1M: 60.0 },
  "o3-mini": { promptPer1M: 1.1, completionPer1M: 4.4 },
  o3: { promptPer1M: 10.0, completionPer1M: 40.0 },
};

/**
 * Look up pricing metadata for a model.
 * Tries exact match first, then prefix match for versioned variants.
 * Returns undefined for unknown models.
 */
export function lookupPricing(model: string): ModelPricing | undefined {
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  return key ? PRICING[key] : undefined;
}

/**
 * Calculate estimated cost in USD for a given model + token usage.
 * Returns 0 for unknown models or undefined inputs — never throws.
 */
export function calculateCost(
  model: string | undefined,
  usage: Pick<TokenUsage, "promptTokens" | "completionTokens">,
): number {
  if (!model) return 0;
  const pricing = lookupPricing(model);
  if (!pricing) return 0;
  return (
    (usage.promptTokens / 1_000_000) * pricing.promptPer1M +
    (usage.completionTokens / 1_000_000) * pricing.completionPer1M
  );
}

/** Format a cost in USD as a human-readable string (e.g. "$0.0045"). */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
