import { createProvider } from "@earendil-works/pi-ai";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { z } from "zod";
import { ChatReply } from "@/ai/chat-reply";
import type { ModelProfile } from "@/ai/model-profile";

/**
 * The pi-ai provider for Starlight's chat model: OpenRouter's completions API pinned to the
 * configured route. pi-ai user messages carry only text and images, so non-image media rides
 * as an image part with its real MIME type and is rewritten here into the part OpenRouter
 * expects, matching what @openrouter/ai-sdk-provider sends for AI SDK file parts.
 */
export namespace OpenRouter {
  export const providerId = "starlight-openrouter";
  const BASE_URL = "https://openrouter.ai/api/v1";

  // OpenRouter accepts these input_audio formats; Telegram voice notes are audio/ogg.
  const AUDIO_FORMATS: Record<string, string> = {
    aac: "aac",
    aiff: "aiff",
    flac: "flac",
    m4a: "m4a",
    mp3: "mp3",
    mp4: "m4a",
    mpeg: "mp3",
    ogg: "ogg",
    wav: "wav",
    "x-m4a": "m4a",
    "x-wav": "wav",
  };

  export function model(profile: ModelProfile.Profile): Model<"openai-completions"> {
    return {
      api: "openai-completions",
      baseUrl: BASE_URL,
      compat: {
        openRouterRouting: {
          allow_fallbacks: profile.route.allowFallbacks,
          only: [...profile.route.only],
          require_parameters: profile.route.requireParameters,
        },
        sendSessionAffinityHeaders: true,
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
      },
      contextWindow: 1_048_576,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: profile.model,
      input: ["text", "image"],
      maxTokens: ChatReply.maxOutputTokens,
      name: profile.model,
      provider: providerId,
      reasoning: true,
    };
  }

  // Only the parts this rewrite reads; everything else passes through untouched.
  const payloadSchema = z.looseObject({ messages: z.array(z.looseObject({ role: z.string() })) });

  const userMessageSchema = z.looseObject({
    content: z.array(z.looseObject({ image_url: z.object({ url: z.string() }).optional(), type: z.string() })),
    role: z.literal("user"),
  });

  export function provider(apiKey: string, profile: ModelProfile.Profile): Provider<"openai-completions"> {
    // The provider serves exactly this model, so streams use it instead of narrowing the target.
    const completions = model(profile);

    return createProvider<"openai-completions">({
      auth: {
        apiKey: {
          name: "OpenRouter API key",
          resolve: async () => await Promise.resolve({ auth: { apiKey }, source: "OPENROUTER_API_KEY" }),
        },
      },
      api: {
        stream: (_target, context, options) =>
          stream(completions, context, {
            ...options,
            onPayload: (payload) => rewriteMedia(payloadSchema.parse(payload)),
          }),
        streamSimple: (_target, context, options) =>
          streamSimple(completions, context, {
            ...options,
            onPayload: (payload) => rewriteMedia(payloadSchema.parse(payload)),
          }),
      },
      baseUrl: BASE_URL,
      id: providerId,
      models: [completions],
    });
  }

  function rewriteMedia(payload: z.infer<typeof payloadSchema>) {
    return {
      ...payload,
      messages: payload.messages.map((message) => {
        const user = userMessageSchema.safeParse(message);

        return user.success ? { ...user.data, content: user.data.content.map(rewritePart) } : message;
      }),
    };
  }

  function rewritePart(part: z.infer<typeof userMessageSchema>["content"][number]) {
    if (part.type !== "image_url" || part.image_url === undefined) return part;
    const { url } = part.image_url;
    const mimeType = url.slice("data:".length, url.indexOf(";"));

    if (mimeType.startsWith("image/")) return part;

    if (mimeType.startsWith("video/")) return { type: "video_url", video_url: { url } };

    const audioFormat = AUDIO_FORMATS[mimeType.replace("audio/", "")];

    if (mimeType.startsWith("audio/") && audioFormat !== undefined) {
      return { input_audio: { data: url.slice(url.indexOf(",") + 1), format: audioFormat }, type: "input_audio" };
    }

    const extension = mimeType === "application/pdf" ? "pdf" : (mimeType.split("/").at(1) ?? "bin");

    return { file: { file_data: url, filename: `attachment.${extension}` }, type: "file" };
  }
}
