export namespace ModelProfile {
  export const ids = {
    gemini3FlashPreview: "google/gemini-3-flash-preview",
    gemini37Flash: "google/gemini-3.7-flash",
  } as const;
  export const modelIds = [ids.gemini37Flash, ids.gemini3FlashPreview] as const;
  export const outputProtocols = {
    finalOutputTool: "final-output-tool",
    jsonSchemaResponse: "json-schema-response",
  } as const;

  export type ModelId = (typeof modelIds)[number];
  export type OutputProtocol = (typeof outputProtocols)[keyof typeof outputProtocols];

  export interface Profile {
    readonly limits: {
      readonly defaultOutputTokens: number;
      readonly maximumOutputTokens: number;
    };
    readonly model: ModelId;
    readonly output: { readonly protocol: OutputProtocol };
    readonly reasoning: { readonly effort: "low" };
    readonly route: {
      readonly allowFallbacks: false;
      readonly only: readonly ["google-vertex/global"];
      readonly requireParameters: true;
    };
  }

  const common = {
    limits: {
      defaultOutputTokens: 8192,
      maximumOutputTokens: 65_536,
    },
    reasoning: { effort: "low" },
    route: {
      allowFallbacks: false,
      only: ["google-vertex/global"],
      requireParameters: true,
    },
  } as const;

  export const profiles = {
    [ids.gemini3FlashPreview]: {
      ...common,
      model: ids.gemini3FlashPreview,
      output: { protocol: outputProtocols.finalOutputTool },
    },
    [ids.gemini37Flash]: {
      ...common,
      model: ids.gemini37Flash,
      output: { protocol: outputProtocols.finalOutputTool },
    },
  } as const satisfies Record<ModelId, Profile>;

  export function fromModelId(model: string | undefined): Profile {
    if (model === undefined || model === ids.gemini37Flash) {
      return profiles[ids.gemini37Flash];
    }
    if (model === ids.gemini3FlashPreview) {
      return profiles[ids.gemini3FlashPreview];
    }
    throw new Error(`Unsupported Starlight model: ${model}`);
  }

  export const selected = fromModelId(process.env.STARLIGHT_MODEL || undefined);
}
