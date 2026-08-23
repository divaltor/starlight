import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { StrictMode } from "react";
import appCss from "@/index.css?url";
import { TelegramButtonsProvider } from "@/providers/telegram-buttons-provider";
import type { orpc } from "@/utils/orpc";

export interface RouterAppContext {
  orpc: typeof orpc;
  queryClient: QueryClient;
}

const APP_TITLE = "Starlight Gallery";

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
        title: APP_TITLE,
      },
      {
        property: "og:title",
        content: APP_TITLE,
      },
      {
        property: "og:description",
        content: "View the your liked anime arts on X (Twitter).",
      },
      {
        property: "og:image",
        content: "/og.webp",
      },
      {
        property: "twitter:card",
        name: "summary_large_image",
      },
      {
        name: "twitter:title",
        content: APP_TITLE,
      },
      {
        name: "twitter:description",
        content: "View your liked anime arts on X (Twitter).",
      },
      {
        name: "twitter:image",
        content: "/og.webp",
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
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-base-100">
        <TelegramButtonsProvider>
          <StrictMode>
            <NuqsAdapter>
              <Outlet />
            </NuqsAdapter>
          </StrictMode>
        </TelegramButtonsProvider>
        {import.meta.env.DEV && (
          <>
            <TanStackRouterDevtools position="bottom-left" />
            <ReactQueryDevtools buttonPosition="bottom-right" position="bottom" />
          </>
        )}
        <Scripts />
      </body>
    </html>
  );
}
