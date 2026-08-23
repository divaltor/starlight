import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { Option, Schema } from "effect";
import type { TokenPrices } from "@/ai/model-profile";

const OpenRouterMetadata = Schema.Struct({
	provider: Schema.optional(Schema.String),
	usage: Schema.optional(
		Schema.Struct({
			completionTokens: Schema.optional(Schema.Number),
			completionTokensDetails: Schema.optional(
				Schema.Struct({ reasoningTokens: Schema.optional(Schema.Number) }),
			),
			cost: Schema.optional(Schema.Number),
			promptTokens: Schema.optional(Schema.Number),
			promptTokensDetails: Schema.optional(
				Schema.Struct({ cachedTokens: Schema.optional(Schema.Number) }),
			),
		}),
	),
});

export const CACHE_RESULTS = ["confirmed-hit", "confirmed-miss", "invalid", "unknown"] as const;
export type CacheResult = (typeof CACHE_RESULTS)[number];

export interface StepUsage {
	readonly cacheReadTokens: number | null;
	readonly cacheResult: CacheResult;
	readonly cacheWriteTokens: number | null;
	readonly estimatedCostUsd: number | null;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly reasoningTokens: number | null;
	readonly reportedCostUsd: number | null;
	readonly selectedCostUsd: number | null;
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
	readonly steps: readonly StepUsage[];
	readonly validForCostThresholds: boolean;
}

export function normalizeStepUsage(
	usage: LanguageModelUsage,
	providerMetadata: ProviderMetadata | undefined,
	prices: TokenPrices,
): StepUsage {
	const openRouterUsage = decodeOpenRouterMetadata(providerMetadata)?.usage;
	const inputTokens = firstNumber(usage.inputTokens, openRouterUsage?.promptTokens);
	const cacheReadTokens = firstNumber(
		usage.inputTokenDetails.cacheReadTokens,
		openRouterUsage?.promptTokensDetails?.cachedTokens,
	);
	const cacheWriteTokens = firstNumber(usage.inputTokenDetails.cacheWriteTokens);
	const outputTokens = firstNumber(usage.outputTokens, openRouterUsage?.completionTokens);
	const reasoningTokens = firstNumber(
		usage.outputTokenDetails.reasoningTokens,
		openRouterUsage?.completionTokensDetails?.reasoningTokens,
	);
	const cacheResult = classifyCacheResult(inputTokens, cacheReadTokens);
	const uncachedInputTokens =
		cacheResult === "invalid" ? null : calculateUncachedInput(inputTokens, cacheReadTokens);
	const estimatedCostUsd = estimateCostUsd(
		{
			cacheReadTokens,
			cacheWriteTokens,
			outputTokens,
			reasoningTokens,
			uncachedInputTokens,
		},
		prices,
	);
	const reportedCostUsd = firstNumber(openRouterUsage?.cost);

	return {
		cacheReadTokens,
		cacheResult,
		cacheWriteTokens,
		estimatedCostUsd,
		inputTokens,
		outputTokens,
		reasoningTokens,
		reportedCostUsd,
		selectedCostUsd: reportedCostUsd ?? estimatedCostUsd,
		uncachedInputTokens,
	};
}

export function aggregateGenerationUsage(steps: readonly StepUsage[]): GenerationUsage {
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
			steps: [],
			validForCostThresholds: false,
		};
	}

	const costUsd = sumKnown(steps.map((step) => step.selectedCostUsd));

	return {
		billing: {
			cacheReadTokens: sumKnown(steps.map((step) => step.cacheReadTokens)),
			cacheWriteTokens: sumKnown(steps.map((step) => step.cacheWriteTokens)),
			costUsd,
			inputTokens: sumKnown(steps.map((step) => step.inputTokens)),
			outputTokens: sumKnown(steps.map((step) => step.outputTokens)),
			reasoningTokens: sumKnown(steps.map((step) => step.reasoningTokens)),
		},
		contextInputTokens: steps.at(-1)?.inputTokens ?? null,
		steps: [...steps],
		validForCostThresholds:
			costUsd !== null && steps.every((step) => step.cacheResult !== "invalid"),
	};
}

export function getUpstreamProvider(providerMetadata: ProviderMetadata | undefined): string | null {
	return decodeOpenRouterMetadata(providerMetadata)?.provider ?? null;
}

function decodeOpenRouterMetadata(providerMetadata: ProviderMetadata | undefined) {
	return Option.getOrUndefined(
		Schema.decodeUnknownOption(OpenRouterMetadata)(providerMetadata?.openrouter),
	);
}

function classifyCacheResult(
	inputTokens: number | null,
	cacheReadTokens: number | null,
): CacheResult {
	if (inputTokens === null || cacheReadTokens === null) {
		return "unknown";
	}

	if (cacheReadTokens > inputTokens) {
		return "invalid";
	}

	return cacheReadTokens > 0 ? "confirmed-hit" : "confirmed-miss";
}

function calculateUncachedInput(
	inputTokens: number | null,
	cacheReadTokens: number | null,
): number | null {
	if (inputTokens === null || cacheReadTokens === null) {
		return null;
	}

	return inputTokens - cacheReadTokens;
}

function estimateCostUsd(
	usage: Pick<
		StepUsage,
		| "cacheReadTokens"
		| "cacheWriteTokens"
		| "outputTokens"
		| "reasoningTokens"
		| "uncachedInputTokens"
	>,
	prices: TokenPrices,
): number | null {
	if (usage.cacheReadTokens === null) return null;
	if (usage.cacheWriteTokens === null) return null;
	if (usage.outputTokens === null) return null;
	if (usage.uncachedInputTokens === null) return null;
	if (prices.cacheReadUsdPerMillionTokens === null) return null;
	if (prices.cacheWriteUsdPerMillionTokens === null) return null;
	if (prices.inputUsdPerMillionTokens === null) return null;
	if (prices.outputUsdPerMillionTokens === null) return null;

	const outputCost = estimateOutputCostUsd(usage, prices);
	if (outputCost === null) return null;

	return (
		(usage.uncachedInputTokens * prices.inputUsdPerMillionTokens +
			usage.cacheReadTokens * prices.cacheReadUsdPerMillionTokens +
			usage.cacheWriteTokens * prices.cacheWriteUsdPerMillionTokens) /
			1_000_000 +
		outputCost
	);
}

function estimateOutputCostUsd(
	usage: Pick<StepUsage, "outputTokens" | "reasoningTokens">,
	prices: TokenPrices,
): number | null {
	if (usage.outputTokens === null || prices.outputUsdPerMillionTokens === null) return null;

	if (usage.reasoningTokens === null) {
		return prices.reasoningUsdPerMillionTokens === prices.outputUsdPerMillionTokens
			? (usage.outputTokens * prices.outputUsdPerMillionTokens) / 1_000_000
			: null;
	}

	if (prices.reasoningUsdPerMillionTokens === null) return null;

	return (
		(Math.max(usage.outputTokens - usage.reasoningTokens, 0) * prices.outputUsdPerMillionTokens +
			usage.reasoningTokens * prices.reasoningUsdPerMillionTokens) /
		1_000_000
	);
}

function firstNumber(...values: readonly (number | undefined)[]): number | null {
	return values.find((value) => value !== undefined) ?? null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
	return values.includes(null)
		? null
		: values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
