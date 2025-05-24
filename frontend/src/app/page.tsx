"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
	const router = useRouter();

	useEffect(() => {
		const checkTelegramEnvironment = () => {
			// Check if we're in a Telegram environment
			const hasWebAppData =
				typeof window !== "undefined" &&
				// Check for Telegram WebApp
				(window.Telegram?.WebApp ||
					// Check for launch parameters in URL
					window.location.href.includes("tgWebAppPlatform") ||
					// Check for Telegram WebApp data in URL
					window.location.href.includes("tgWebApp") ||
					// Check for any Telegram-specific parameters
					new URLSearchParams(window.location.search).has("tgWebAppPlatform") ||
					// Check if we're in development mode (localhost)
					window.location.hostname === "localhost" ||
					window.location.hostname === "127.0.0.1");

			if (hasWebAppData) {
				// Valid Telegram environment or development, redirect to app
				router.replace("/app");
			} else {
				// Not in Telegram environment, redirect to not-found
				router.replace("/not-found");
			}
		};

		// Small delay to ensure window object is fully loaded
		const timeoutId = setTimeout(checkTelegramEnvironment, 100);

		return () => clearTimeout(timeoutId);
	}, [router]);

	// Show loading state while checking
	return (
		<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
			<div className="text-center">
				<div className="animate-pulse">
					<div className="h-8 w-8 bg-primary rounded-full mx-auto mb-4" />
					<p className="text-muted-foreground">Checking environment...</p>
				</div>
			</div>
		</div>
	);
}
