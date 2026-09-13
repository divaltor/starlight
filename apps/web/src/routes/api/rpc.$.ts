// biome-ignore-all lint/style/useFilenamingConvention: TanStack file route requires "$" in filename for dynamic segments
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import { appRouter } from "@starlight/api/routers/index";
import { createFileRoute } from "@tanstack/react-router";
import { corsOrigin, createApiContext } from "@/api.server";
import { traceRpcRequest } from "@/telemetry.server";

const rpcHandler = new RPCHandler(appRouter, {
  plugins: [
    new CORSPlugin({
      origin: corsOrigin,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id", "traceparent", "tracestate", "baggage"],
      credentials: true,
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error("RPC handler error", { error });
    }),
  ],
});

function handleRPC({ request }: { request: Request }) {
  return traceRpcRequest(request, async () => {
    const context = createApiContext(request);

    const { matched, response } = await rpcHandler.handle(request, {
      prefix: "/api/rpc",
      context,
    });

    if (matched) {
      return response;
    }

    return new Response("Not Found", { status: 404 });
  });
}

export const Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      GET: handleRPC,
      POST: handleRPC,
    },
  },
});
