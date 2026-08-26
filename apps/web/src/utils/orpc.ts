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
import { createApiContext } from "@/api.server";

const serializer = new StandardRPCJsonSerializer({
  customJsonSerializers: [],
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
        deserializeData: (data) => serializer.deserialize(data.json, data.meta),
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
          return telemetry.traceRpcRequest(request, init);
        },
      }),
    );
  });

export const client: AppRouterClient = getORPCClient();

export const orpc = createTanstackQueryUtils(client);
