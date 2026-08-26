import { createMCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { z } from "zod";

export namespace Exa {
  const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp";
  const ENABLED_TOOLS = ["web_search_exa", "web_fetch_exa"] as const;

  const toolSchemas = {
    web_fetch_exa: {
      inputSchema: z.object({
        maxCharacters: z.number().int().positive().max(6000).optional(),
        urls: z.array(z.url()).length(1),
      }),
    },
    web_search_exa: {
      inputSchema: z.object({
        numResults: z.number().int().positive().max(5).default(3),
        query: z.string().min(3).max(300),
      }),
    },
  };

  export class ExaError extends Schema.TaggedError<ExaError>()("ExaError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }) {
    static fromCause(message: string, cause: unknown) {
      return new ExaError({ cause, message });
    }
  }

  export interface Interface {
    readonly isEnabled: () => boolean;
    readonly tools: ToolSet;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Exa") {}

  export const layer: Layer.Layer<Service, ExaError> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const enabled = yield* Config.boolean("EXA_MCP_ENABLED").pipe(Config.withDefault(true));
      if (!enabled) return Service.of({ isEnabled: () => false, tools: {} });

      const configuredApiKey = yield* Config.option(Config.redacted("EXA_API_KEY"));
      const configuredMcpUrl = yield* Config.string("EXA_MCP_URL").pipe(Config.withDefault(DEFAULT_MCP_URL));
      const apiKey = configuredApiKey.pipe(
        Option.flatMap((value) => {
          const key = Redacted.value(value).trim();
          return key ? Option.some(key) : Option.none();
        }),
      );
      const mcpUrl = new URL(configuredMcpUrl.trim() || DEFAULT_MCP_URL);
      mcpUrl.searchParams.set("tools", ENABLED_TOOLS.join(","));

      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createMCPClient({
              transport: {
                headers: Option.isSome(apiKey) ? { "x-api-key": apiKey.value } : undefined,
                type: "http",
                url: mcpUrl.toString(),
              },
            }),
          catch: (cause) => ExaError.fromCause("Failed to connect to Exa MCP", cause),
        }),
        (mcpClient) => Effect.promise(() => mcpClient.close()),
      );
      const discoveredTools = yield* Effect.tryPromise({
        try: () => client.tools({ schemas: toolSchemas }),
        catch: (cause) => ExaError.fromCause("Failed to load Exa MCP tools", cause),
      });

      return Service.of({
        isEnabled: () => true,
        tools: discoveredTools,
      });
    }).pipe(
      // Config failures join the service error channel as typed ExaErrors.
      Effect.catchTag("ConfigError", (cause) => Effect.fail(ExaError.fromCause("Invalid Exa configuration", cause))),
    ),
  );

  export const defaultLayer: Layer.Layer<Service, ExaError> = layer;
}
