import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { Option, Schema, SchemaGetter } from "effect";

export namespace Usage {
  const NullableNumber = Schema.NullOr(Schema.Number);
  const NullishNumber = Schema.NullishOr(Schema.Number).pipe(
    Schema.decodeTo(NullableNumber, {
      decode: SchemaGetter.transform((value) => value ?? null),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
  const OpenRouterMetadata = Schema.Struct({
    provider: Schema.optional(Schema.String),
    usage: Schema.optional(Schema.Struct({ cost: Schema.optional(Schema.Number) })),
  });
  const ProviderMetadataSchema = Schema.Struct({ openrouter: Schema.optional(OpenRouterMetadata) });
  const ReportedCost = Schema.Unknown.pipe(
    Schema.decodeTo(NullableNumber, {
      decode: SchemaGetter.transform(
        (providerMetadata) =>
          Option.getOrUndefined(Schema.decodeUnknownOption(ProviderMetadataSchema)(providerMetadata))?.openrouter?.usage
            ?.cost ?? null,
      ),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );

  export const CACHE_RESULTS = ["confirmed-hit", "confirmed-miss", "invalid", "unknown"] as const;
  export const CacheResult = Schema.Literals(CACHE_RESULTS);
  export type CacheResult = typeof CacheResult.Type;

  const StepUsageResult = Schema.Struct({
    cacheReadTokens: NullableNumber,
    cacheResult: CacheResult,
    cacheWriteTokens: NullableNumber,
    inputTokens: NullableNumber,
    outputTokens: NullableNumber,
    reasoningTokens: NullableNumber,
    reportedCostUsd: NullableNumber,
    uncachedInputTokens: NullableNumber,
  });

  const StepUsageInput = Schema.Struct({
    providerMetadata: ReportedCost,
    usage: Schema.Struct({
      inputTokenDetails: Schema.Struct({
        cacheReadTokens: NullishNumber,
        cacheWriteTokens: NullishNumber,
        noCacheTokens: NullishNumber,
      }),
      inputTokens: NullishNumber,
      outputTokenDetails: Schema.Struct({ reasoningTokens: NullishNumber }),
      outputTokens: NullishNumber,
    }),
  });

  export const StepUsage = StepUsageInput.pipe(
    Schema.decodeTo(StepUsageResult, {
      decode: SchemaGetter.transform((input) => {
        // Dot notation is the project convention; destructuring is intentionally disabled.
        // oxlint-disable-next-line prefer-destructuring
        const inputTokens = input.usage.inputTokens;
        // oxlint-disable-next-line prefer-destructuring
        const cacheReadTokens = input.usage.inputTokenDetails.cacheReadTokens;
        const cacheResult: CacheResult = (() => {
          if (inputTokens === null || cacheReadTokens === null) return "unknown";
          if (cacheReadTokens > inputTokens) return "invalid";
          return cacheReadTokens > 0 ? "confirmed-hit" : "confirmed-miss";
        })();
        const uncachedInputTokens = (() => {
          if (cacheResult === "invalid") return null;
          if (input.usage.inputTokenDetails.noCacheTokens !== null) {
            return input.usage.inputTokenDetails.noCacheTokens;
          }
          if (inputTokens === null || cacheReadTokens === null) return null;
          return inputTokens - cacheReadTokens;
        })();

        return {
          cacheReadTokens,
          cacheResult,
          cacheWriteTokens: input.usage.inputTokenDetails.cacheWriteTokens,
          inputTokens,
          outputTokens: input.usage.outputTokens,
          reasoningTokens: input.usage.outputTokenDetails.reasoningTokens,
          reportedCostUsd: input.providerMetadata,
          uncachedInputTokens,
        };
      }),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
  export type StepUsage = typeof StepUsage.Type;

  const GenerationUsageResult = Schema.Struct({
    billing: Schema.Struct({
      cacheReadTokens: NullableNumber,
      cacheWriteTokens: NullableNumber,
      costUsd: NullableNumber,
      inputTokens: NullableNumber,
      outputTokens: NullableNumber,
      reasoningTokens: NullableNumber,
    }),
    contextInputTokens: NullableNumber,
    stepCount: Schema.Int,
  });

  export const GenerationUsage = Schema.Array(StepUsageResult).pipe(
    Schema.decodeTo(GenerationUsageResult, {
      decode: SchemaGetter.transform((steps) => ({
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
      })),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
  export type GenerationUsage = typeof GenerationUsage.Type;

  export function normalizeStep(usage: LanguageModelUsage, providerMetadata?: ProviderMetadata): StepUsage {
    return Schema.decodeSync(StepUsage)({ providerMetadata, usage });
  }

  export function aggregate(steps: readonly StepUsage[]): GenerationUsage {
    return Schema.decodeSync(GenerationUsage)(steps);
  }

  export function upstreamProvider(providerMetadata: ProviderMetadata | undefined): string | null {
    return decodeOpenRouterMetadata(providerMetadata)?.provider ?? null;
  }

  function decodeOpenRouterMetadata(providerMetadata: ProviderMetadata | undefined) {
    return Option.getOrUndefined(Schema.decodeUnknownOption(ProviderMetadataSchema)(providerMetadata))?.openrouter;
  }

  function sumKnown(values: readonly (number | null)[]): number | null {
    if (values.length === 0) return null;
    return values.includes(null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  }
}
