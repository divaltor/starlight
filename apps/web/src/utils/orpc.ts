import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { StandardRPCJsonSerializer } from "@orpc/client/standard";
import { createRouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@starlight/api/routers/index";
import { appRouter } from "@starlight/api/routers/index";
import { defaultShouldDehydrateQuery, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { z } from "zod";
import { createApiContext } from "@/api.server";

const serializer = new StandardRPCJsonSerializer({
  customJsonSerializers: [],
});

const serializedDataSchema = z.object({
  json: z.unknown(),
  meta: z.array(z.tuple([z.number()], z.union([z.string(), z.number()]))),
});

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: (queryKey) => {
          const [json, meta] = serializer.serialize(queryKey);

          return JSON.stringify({ json, meta });
        },
        staleTime: 60 * 1000,
      },
      dehydrate: {
        shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) || query.state.status === "pending",
        serializeData: (data) => {
          const [json, meta] = serializer.serialize(data);

          return { json, meta };
        },
      },
      hydrate: {
        deserializeData: (data: z.input<typeof serializedDataSchema>) => {
          const serialized = serializedDataSchema.parse(data);

          return serializer.deserialize(serialized.json, serialized.meta);
        },
      },
    },
  });
}

export const queryClient = createQueryClient();

const getORPCClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(appRouter, {
      context: () => {
        const request = getRequest();

        return createApiContext(request);
      },
    }),
  )
  .client((): AppRouterClient => {
    let rawInitData: string;

    try {
      rawInitData = retrieveRawInitData() ?? "";
    } catch {
      rawInitData = "";
    }

    return createORPCClient(
      new RPCLink({
        url: `${window.location.origin}/api/rpc`,
        headers: {
          Authorization: rawInitData,
        },
        fetch: async (request, init) => {
          const telemetry = await import("@/telemetry.client");

          return await telemetry.traceRpcRequest(request, init);
        },
      }),
    );
  });

export const client: AppRouterClient = getORPCClient();

export const orpc = createTanstackQueryUtils(client);
