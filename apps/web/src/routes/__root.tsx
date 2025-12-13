import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { StrictMode } from "react";
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
				title: "Starlight Gallery",
			},
			{
				property: "og:title",
				content: "Starlight Gallery",
			},
			{
				property: "og:description",
				content: "View the your liked anime arts on X (Twitter).",
			},
			{
				property: "og:image",
				content: "/og.png",
			},
			{
				property: "twitter:card",
				name: "summary_large_image",
			},
			{
				name: "twitter:title",
				content: "Starlight Gallery",
			},
			{
				name: "twitter:description",
				content: "View your liked anime arts on X (Twitter).",
			},
			{
				name: "twitter:image",
				content: "/og.png",
			},
		],
		links: [
			{
				rel: "icon",
				type: "image/x-icon",
				href: "/favicon.ico",
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
						<NuqsAdapter>
							<Outlet />
						</NuqsAdapter>
					</StrictMode>
				</TelegramButtonsProvider>
				<TanStackRouterDevtools position="bottom-left" />
				<ReactQueryDevtools buttonPosition="bottom-right" position="bottom" />
				<Scripts />
			</body>
		</html>
	);
}
