import { expect, test } from "bun:test";
import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { selected } from "@/ai/model-profile";
import * as Usage from "@/ai/usage";

test("keeps missing cache detail unknown", () => {
  expect(Usage.normalizeStep(createUsage({}), undefined, selected.prices)).toMatchObject({
    cacheReadTokens: null,
    cacheResult: "unknown",
    estimatedCostUsd: null,
    uncachedInputTokens: null,
  });
});

test("uses provider-reported cost before a local estimate", () => {
  const usage = Usage.normalizeStep(
    createUsage({ cacheReadTokens: 80, cacheWriteTokens: 0 }),
    createProviderMetadata(0.0031),
    selected.prices,
  );

  expect(usage.reportedCostUsd).toBe(0.0031);
  expect(usage.estimatedCostUsd).not.toBeNull();
  expect(usage.selectedCostUsd).toBe(0.0031);
});

test("sums billing input but keeps final context input separate", () => {
  const first = Usage.normalizeStep(
    createUsage({ cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100 }),
    createProviderMetadata(0.001),
    selected.prices,
  );
  const second = Usage.normalizeStep(
    createUsage({ cacheReadTokens: 80, cacheWriteTokens: 0, inputTokens: 140 }),
    createProviderMetadata(0.002),
    selected.prices,
  );

  expect(Usage.aggregate([first, second])).toMatchObject({
    billing: {
      costUsd: 0.003,
      inputTokens: 240,
    },
    contextInputTokens: 140,
    validForCostThresholds: true,
  });
});

test("excludes inconsistent cache usage from cost thresholds", () => {
  const usage = Usage.normalizeStep(
    createUsage({ cacheReadTokens: 101, cacheWriteTokens: 0, inputTokens: 100 }),
    createProviderMetadata(0.001),
    selected.prices,
  );

  expect(usage.cacheResult).toBe("invalid");
  expect(usage.uncachedInputTokens).toBeNull();
  expect(Usage.aggregate([usage]).validForCostThresholds).toBe(false);
});

test("keeps usage unknown when an invocation records no provider step", () => {
  expect(Usage.aggregate([])).toEqual({
    billing: {
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
    },
    contextInputTokens: null,
    steps: [],
    validForCostThresholds: false,
  });
});

function createUsage(input: {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly noCacheTokens?: number;
}): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      noCacheTokens: input.noCacheTokens,
    },
    inputTokens: input.inputTokens ?? 100,
    outputTokenDetails: {
      reasoningTokens: 2,
      textTokens: 8,
    },
    outputTokens: 10,
    totalTokens: (input.inputTokens ?? 100) + 10,
  };
}

function createProviderMetadata(cost: number): ProviderMetadata {
  return {
    openrouter: {
      provider: "Google",
      usage: {
        completionTokens: 10,
        cost,
        promptTokens: 100,
        totalTokens: 110,
      },
    },
  };
}
