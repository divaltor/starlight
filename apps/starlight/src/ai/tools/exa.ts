import { createMCPClient } from "@ai-sdk/mcp";
import type { CallToolResult } from "@ai-sdk/mcp";
import type { ToolExecutionOptions, ToolSet } from "ai";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { z } from "zod";
import { Youtube } from "@/ai/tools/youtube";

export namespace Exa {
  export const profileId = "exa-mcp-v3-limited";
  export const fetchUrl = z.url().refine((url) => !Youtube.urlPattern.test(url), "Use read_youtube for YouTube URLs");
  export const searchQuery = z
    .string()
    .min(3)
    .max(300)
    .refine(
      (query) => !(query.match(/https?:\/\/[^\s"'<>]+/giu) ?? []).some((url) => Youtube.urlPattern.test(url)),
      "Use read_youtube for YouTube URLs",
    );
  const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp";
  const ENABLED_TOOLS = ["web_search_exa", "web_fetch_exa"] as const;

  const toolDefinitions = {
    web_fetch_exa: {
      description:
        "Fetch the readable content of one non-YouTube web page. Never use this for a YouTube URL or as a fallback when read_youtube fails.",
      inputSchema: z.object({
        maxCharacters: z.number().int().positive().max(6000).optional(),
        urls: z.array(fetchUrl).length(1),
      }),
    },
    web_search_exa: {
      description:
        "Search the web for current, niche, ambiguous, or uncertain factual information. Never use this to inspect, identify, or summarize a specific YouTube video, including as a fallback when read_youtube fails.",
      inputSchema: z.object({
        numResults: z.number().int().positive().max(5).default(3),
        query: searchQuery,
      }),
    },
  };

  type FetchInput = z.infer<typeof toolDefinitions.web_fetch_exa.inputSchema>;
  type SearchInput = z.infer<typeof toolDefinitions.web_search_exa.inputSchema>;

  const RATE_LIMIT_PATTERN = /free\s+(?:mcp\s+|plan\s+)?rate limit/iu;

  // Exa signals free-tier exhaustion as a successful tool result, never as a
  // thrown transport error (observed trace 4e7ce778/52728809c282f741:
  // _meta["ai.exa/rateLimited"]===true with isError:false). One typed check
  // on CallToolResult covers the retry decision; other failures propagate.
  function isRateLimitedResult(output: CallToolResult): boolean {
    if (output._meta?.["ai.exa/rateLimited"] === true) return true;
    if (!("content" in output) || !Array.isArray(output.content)) return false;
    return output.content.some((item) => item.type === "text" && RATE_LIMIT_PATTERN.test(item.text));
  }

  export class ExaError extends Schema.TaggedError<ExaError>()("ExaError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }) {
    static fromCause(message: string, cause: unknown) {
      return new ExaError({ cause, message });
    }
  }

  export interface Interface {
    readonly tools: ToolSet;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Exa") {}

  export const layer: Layer.Layer<Service, ExaError> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const configuredApiKey = yield* Config.option(Config.Redacted("EXA_API_KEY"));
      const configuredMcpUrl = yield* Config.String("EXA_MCP_URL").pipe(Config.withDefault(DEFAULT_MCP_URL));
      const apiKey = configuredApiKey.pipe(
        Option.flatMap((value) => {
          const key = Redacted.value(value).trim();
          return key ? Option.some(key) : Option.none();
        }),
      );
      const mcpUrl = new URL(configuredMcpUrl.trim() || DEFAULT_MCP_URL);
      mcpUrl.searchParams.set("tools", ENABLED_TOOLS.join(","));
      const targetUrl = mcpUrl.toString();

      const freeClient = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createMCPClient({
              transport: {
                type: "http",
                url: targetUrl,
              },
            }),
          catch: (cause) => ExaError.fromCause("Failed to connect to Exa MCP", cause),
        }),
        (mcpClient) => Effect.promise(() => mcpClient.close()),
      );
      const freeDiscovered = yield* Effect.tryPromise({
        try: () => freeClient.tools({ schemas: toolDefinitions }),
        catch: (cause) => ExaError.fromCause("Failed to load Exa MCP tools", cause),
      });
      if (ENABLED_TOOLS.some((name) => !freeDiscovered[name]?.execute)) {
        return yield* new ExaError({ message: "Required Exa MCP tool is unavailable" });
      }

      const paidKey = Option.isSome(apiKey) ? apiKey.value : null;

      const runPaid = async (
        key: string,
        name: (typeof ENABLED_TOOLS)[number],
        args: FetchInput | SearchInput,
        signal?: AbortSignal,
      ): Promise<CallToolResult> => {
        const paidClient = await createMCPClient({
          transport: {
            headers: { "x-api-key": key },
            type: "http",
            url: targetUrl,
          },
        });
        try {
          return await paidClient.callTool({ arguments: { ...args }, name, options: { signal } });
        } finally {
          await paidClient.close();
        }
      };

      // Free route is the default; a rate-limited call retries once with the
      // API key on an ephemeral paid client, then the next call starts free again.
      const runFreeOrPaid = async (
        name: (typeof ENABLED_TOOLS)[number],
        args: FetchInput | SearchInput,
        signal?: AbortSignal,
      ): Promise<CallToolResult> => {
        const freeCall = () => freeClient.callTool({ arguments: { ...args }, name, options: { signal } });
        if (paidKey === null) return freeCall();
        const first = await freeCall();
        if (!isRateLimitedResult(first)) return first;
        return runPaid(paidKey, name, args, signal);
      };

      const tools = {
        web_fetch_exa: {
          description: toolDefinitions.web_fetch_exa.description,
          execute: (input: FetchInput, options: ToolExecutionOptions<unknown>) =>
            runFreeOrPaid("web_fetch_exa", input, options.abortSignal),
          inputSchema: toolDefinitions.web_fetch_exa.inputSchema,
        },
        web_search_exa: {
          description: toolDefinitions.web_search_exa.description,
          execute: (input: SearchInput, options: ToolExecutionOptions<unknown>) =>
            runFreeOrPaid("web_search_exa", input, options.abortSignal),
          inputSchema: toolDefinitions.web_search_exa.inputSchema,
        },
      } satisfies ToolSet;

      return Service.of({
        tools,
      });
    }).pipe(
      // Config failures join the service error channel as typed ExaErrors.
      Effect.catchTag("ConfigError", (cause) => Effect.fail(ExaError.fromCause("Invalid Exa configuration", cause))),
    ),
  );

  export const defaultLayer: Layer.Layer<Service, ExaError> = layer;
}
