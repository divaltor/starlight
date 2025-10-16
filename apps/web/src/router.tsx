import { createRouter as createTanstackRouter } from "@tanstack/react-router";
import "@/index.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { orpc, queryClient } from "@/utils/orpc";

export const getRouter = () => {
	const router = createTanstackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
		context: { queryClient, orpc },
		defaultNotFoundComponent: () => <div>Not Found</div>,
		Wrap: ({ children }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	});
	return router;
};

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
