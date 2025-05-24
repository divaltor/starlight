"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isTMA } from "@telegram-apps/bridge";

export default function Home() {
	const router = useRouter();

	useEffect(() => {
		const checkTelegramEnvironment = () => {
			// Use official Telegram Mini Apps detection
				console.log("It's Telegram Mini Apps");
				// Valid Telegram environment, redirect to app
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
