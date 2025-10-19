import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { StrictMode } from "react";
import { Toaster } from "@/components/ui/sonner";
import appCss from "@/index.css?url";
import { TelegramButtonsProvider } from "@/providers/telegram-buttons-provider";
import type { orpc } from "@/utils/orpc";

export type RouterAppContext = {
	orpc: typeof orpc;
	queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterAppContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Starlight Manager",
			},
		],
		links: [
			{
				rel: "icon",
				type: "image/x-icon",
				href: "/favicon.ico",
			},
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com",
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap",
			},
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),

	component: RootDocument,
});

function RootDocument() {
	return (
		<html className="light" lang="en">
			{/** biome-ignore lint/style/noHeadElement: Not needed in Tanstack */}
			<head>
				<HeadContent />
			</head>
			<body className="min-h-screen bg-base-100">
				<TelegramButtonsProvider>
					<StrictMode>
						<Outlet />
					</StrictMode>
				</TelegramButtonsProvider>
				<TanStackRouterDevtools position="bottom-left" />
				<ReactQueryDevtools buttonPosition="bottom-right" position="bottom" />
				<Toaster />
				<Scripts />
			</body>
		</html>
	);
}
