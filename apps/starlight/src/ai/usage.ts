import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { Option, Schema } from "effect";

export namespace Usage {
  const OpenRouterMetadata = Schema.Struct({
    provider: Schema.optional(Schema.String),
    usage: Schema.optional(Schema.Struct({ cost: Schema.optional(Schema.Number) })),
  });

  export const CACHE_RESULTS = ["confirmed-hit", "confirmed-miss", "invalid", "unknown"] as const;
  export type CacheResult = (typeof CACHE_RESULTS)[number];

  export interface StepUsage {
    readonly cacheReadTokens: number | null;
    readonly cacheResult: CacheResult;
    readonly cacheWriteTokens: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly reasoningTokens: number | null;
    readonly reportedCostUsd: number | null;
    readonly uncachedInputTokens: number | null;
  }

  export interface GenerationUsage {
    readonly billing: {
      readonly cacheReadTokens: number | null;
      readonly cacheWriteTokens: number | null;
      readonly costUsd: number | null;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly reasoningTokens: number | null;
    };
    readonly contextInputTokens: number | null;
    readonly stepCount: number;
  }

  export function normalizeStep(usage: LanguageModelUsage, providerMetadata?: ProviderMetadata): StepUsage {
    const inputTokens = firstNumber(usage.inputTokens);
    const cacheReadTokens = firstNumber(usage.inputTokenDetails.cacheReadTokens);
    const cacheWriteTokens = firstNumber(usage.inputTokenDetails.cacheWriteTokens);
    const outputTokens = firstNumber(usage.outputTokens);
    const reasoningTokens = firstNumber(usage.outputTokenDetails.reasoningTokens);
    const cacheResult = classifyCacheResult(inputTokens, cacheReadTokens);
    const uncachedInputTokens =
      cacheResult === "invalid"
        ? null
        : firstNumber(usage.inputTokenDetails.noCacheTokens, calculateUncachedInput(inputTokens, cacheReadTokens));

    return {
      cacheReadTokens,
      cacheResult,
      cacheWriteTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
      reportedCostUsd: firstNumber(decodeOpenRouterMetadata(providerMetadata)?.usage?.cost),
      uncachedInputTokens,
    };
  }

  export function aggregate(steps: readonly StepUsage[]): GenerationUsage {
    if (steps.length === 0) {
      return {
        billing: {
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
        },
        contextInputTokens: null,
        stepCount: 0,
      };
    }

    return {
      billing: {
        cacheReadTokens: sumKnown(steps.map((step) => step.cacheReadTokens)),
        cacheWriteTokens: sumKnown(steps.map((step) => step.cacheWriteTokens)),
        costUsd: sumKnown(steps.map((step) => step.reportedCostUsd)),
        inputTokens: sumKnown(steps.map((step) => step.inputTokens)),
        outputTokens: sumKnown(steps.map((step) => step.outputTokens)),
        reasoningTokens: sumKnown(steps.map((step) => step.reasoningTokens)),
      },
      contextInputTokens: steps.at(-1)?.inputTokens ?? null,
      stepCount: steps.length,
    };
  }

  export function upstreamProvider(providerMetadata: ProviderMetadata | undefined): string | null {
    return decodeOpenRouterMetadata(providerMetadata)?.provider ?? null;
  }

  function decodeOpenRouterMetadata(providerMetadata: ProviderMetadata | undefined) {
    return Option.getOrUndefined(Schema.decodeUnknownOption(OpenRouterMetadata)(providerMetadata?.openrouter));
  }

  function classifyCacheResult(inputTokens: number | null, cacheReadTokens: number | null): CacheResult {
    if (inputTokens === null || cacheReadTokens === null) {
      return "unknown";
    }

    if (cacheReadTokens > inputTokens) {
      return "invalid";
    }

    return cacheReadTokens > 0 ? "confirmed-hit" : "confirmed-miss";
  }

  function calculateUncachedInput(inputTokens: number | null, cacheReadTokens: number | null): number | null {
    if (inputTokens === null || cacheReadTokens === null) {
      return null;
    }

    return inputTokens - cacheReadTokens;
  }

  function firstNumber(...values: readonly (number | null | undefined)[]): number | null {
    return values.find((value) => value !== undefined && value !== null) ?? null;
  }

  function sumKnown(values: readonly (number | null)[]): number | null {
    return values.includes(null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  }
}
