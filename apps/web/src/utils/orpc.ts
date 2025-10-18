import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createContext } from "@starlight/api/context";
import { appRouter } from "@starlight/api/routers/index";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { toast } from "sonner";

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			toast.error(`Error: ${error.message}`, {
				action: {
					label: "retry",
					onClick: () => {
						queryClient.invalidateQueries();
					},
				},
			});
		},
	}),
});

const getORPCClient = createIsomorphicFn()
	.server(() =>
		createRouterClient(appRouter, {
			context: async ({ context }) => createContext({ context }),
		})
	)
	.client((): RouterClient<typeof appRouter> => {
		let rawInitData: string;

		try {
			rawInitData = retrieveRawInitData() ?? "";
		} catch {
			rawInitData = "";
		}

		return createORPCClient(
			new RPCLink({
				url: `${import.meta.env.VITE_SERVER_URL}/rpc`,
				headers: {
					Authorization: rawInitData,
				},
			})
		);
	});

export const client: RouterClient<typeof appRouter> = getORPCClient();

export const orpc = createTanstackQueryUtils(client);
