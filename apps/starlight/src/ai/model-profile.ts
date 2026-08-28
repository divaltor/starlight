export interface ModelProfile {
  readonly limits: {
    readonly defaultOutputTokens: number;
    readonly maximumOutputTokens: number;
  };
  readonly model: string;
  readonly reasoning: { readonly effort: "low" };
  readonly route: {
    readonly allowFallbacks: false;
    readonly only: readonly ["google-vertex/global"];
    readonly requireParameters: true;
  };
}

export const selected: ModelProfile = {
  limits: {
    defaultOutputTokens: 8192,
    maximumOutputTokens: 65_536,
  },
  model: "google/gemini-3.7-flash",
  reasoning: { effort: "low" },
  route: {
    allowFallbacks: false,
    only: ["google-vertex/global"],
    requireParameters: true,
  },
};
