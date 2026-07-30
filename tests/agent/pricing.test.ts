/**
 * pricing.test.ts — unit tests for calculateCost and formatCost.
 */
import { describe, it, expect } from "vitest";
import {
  calculateCost,
  formatCost,
  lookupPricing,
} from "../../src/agent/pricing.js";

describe("lookupPricing", () => {
  it("returns pricing for exact model name", () => {
    const p = lookupPricing("gpt-4o");
    expect(p).toBeDefined();
    expect(p?.promptPer1M).toBe(2.5);
    expect(p?.completionPer1M).toBe(10.0);
  });

  it("returns pricing for versioned variant via prefix match", () => {
    // "claude-sonnet-4.6" should match "claude-sonnet-4"
    const p = lookupPricing("claude-sonnet-4.6");
    expect(p).toBeDefined();
    expect(p?.promptPer1M).toBe(3.0);
  });

  it("returns pricing for claude-sonnet-4-5 via prefix match", () => {
    // "claude-sonnet-4-5" starts with "claude-sonnet-4"
    const p = lookupPricing("claude-sonnet-4-5");
    expect(p).toBeDefined();
    expect(p?.promptPer1M).toBe(3.0);
  });

  it("returns undefined for unknown model", () => {
    expect(lookupPricing("unknown-model-xyz")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookupPricing("")).toBeUndefined();
  });
});

describe("calculateCost", () => {
  it("calculates cost for claude-sonnet-4", () => {
    const cost = calculateCost("claude-sonnet-4", {
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(cost).toBe(3.0);
  });

  it("calculates cost combining prompt and completion tokens", () => {
    // claude-sonnet-4: $3/1M prompt + $15/1M completion
    const cost = calculateCost("claude-sonnet-4", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    // 1000/1M * 3 + 500/1M * 15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it("returns 0 for unknown model", () => {
    const cost = calculateCost("unknown-llm-7b", {
      promptTokens: 100_000,
      completionTokens: 50_000,
    });
    expect(cost).toBe(0);
  });

  it("returns 0 for undefined model", () => {
    const cost = calculateCost(undefined, {
      promptTokens: 100_000,
      completionTokens: 50_000,
    });
    expect(cost).toBe(0);
  });

  it("returns 0 for mock model", () => {
    const cost = calculateCost("mock", {
      promptTokens: 999_999,
      completionTokens: 999_999,
    });
    expect(cost).toBe(0);
  });

  it("returns 0 when token counts are zero", () => {
    const cost = calculateCost("gpt-4o", {
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it("calculates gpt-4o-mini cost correctly", () => {
    // $0.15/1M prompt + $0.60/1M completion
    const cost = calculateCost("gpt-4o-mini", {
      promptTokens: 100_000,
      completionTokens: 50_000,
    });
    // 100000/1M * 0.15 + 50000/1M * 0.6 = 0.015 + 0.030 = 0.045
    expect(cost).toBeCloseTo(0.045, 6);
  });

  it("works via prefix match for versioned variant (claude-sonnet-4-5)", () => {
    const cost = calculateCost("claude-sonnet-4-5", {
      promptTokens: 2_000_000,
      completionTokens: 0,
    });
    // 2M prompt * $3/M = $6
    expect(cost).toBeCloseTo(6.0, 6);
  });
});

describe("formatCost", () => {
  it("formats zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats small amounts with 4 decimal places", () => {
    expect(formatCost(0.0045)).toBe("$0.0045");
  });

  it("formats amounts >= $0.01 with 2 decimal places", () => {
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0.01)).toBe("$0.01");
  });

  it("formats large amounts correctly", () => {
    expect(formatCost(100.0)).toBe("$100.00");
  });
});
