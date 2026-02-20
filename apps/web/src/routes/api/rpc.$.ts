import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import { createContext } from "@starlight/api/context";
import { appRouter } from "@starlight/api/routers/index";
import { env } from "@starlight/utils";
import { createFileRoute } from "@tanstack/react-router";

const rpcHandler = new RPCHandler(appRouter, {
	plugins: [
		new CORSPlugin({
			origin: env.CORS_ORIGIN,
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
			credentials: true,
		}),
	],
	interceptors: [
		onError((error) => {
			console.error("Error in RPC handler", error);
		}),
	],
});

async function handleRPC({ request }: { request: Request }) {
	const context = await createContext({ request });

	const { matched, response } = await rpcHandler.handle(request, {
		prefix: "/api/rpc",
		context,
	});

	if (matched) {
		return response;
	}

	return new Response("Not Found", { status: 404 });
}

export const Route = createFileRoute("/api/rpc/$")({
	server: {
		handlers: {
			GET: handleRPC,
			POST: handleRPC,
		},
	},
});
