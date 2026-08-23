export interface ModelProfile {
	readonly limits: {
		readonly defaultOutputTokens: number;
		readonly maximumOutputTokens: number;
	};
	readonly model: string;
	readonly prices: TokenPrices;
	readonly reasoning: { readonly effort: "minimal" };
	readonly route: {
		readonly allowFallbacks: false;
		readonly only: readonly ["google-vertex/global"];
		readonly requireParameters: true;
	};
}

export interface TokenPrices {
	readonly cacheReadUsdPerMillionTokens: number | null;
	readonly cacheWriteUsdPerMillionTokens: number | null;
	readonly inputUsdPerMillionTokens: number | null;
	readonly outputUsdPerMillionTokens: number | null;
	readonly reasoningUsdPerMillionTokens: number | null;
}

export const selected: ModelProfile = {
	limits: {
		defaultOutputTokens: 8192,
		maximumOutputTokens: 65_536,
	},
	model: "google/gemini-3.7-flash",
	prices: {
		cacheReadUsdPerMillionTokens: 0.0375,
		cacheWriteUsdPerMillionTokens: 0.020833,
		inputUsdPerMillionTokens: 0.375,
		outputUsdPerMillionTokens: 1.875,
		reasoningUsdPerMillionTokens: 1.875,
	},
	reasoning: { effort: "minimal" },
	route: {
		allowFallbacks: false,
		only: ["google-vertex/global"],
		requireParameters: true,
	},
};
