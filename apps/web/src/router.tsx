import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter as createTanstackRouter } from "@tanstack/react-router";
import NotFound from "@/components/not-found";
import { routeTree } from "@/routeTree.gen";
import { orpc, queryClient } from "@/utils/orpc";

export const getRouter = () => {
	const router = createTanstackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
		context: { queryClient, orpc },
		defaultNotFoundComponent: () => (
			<div className="h-screen bg-base-100 p-4">
				<NotFound />
			</div>
		),
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
