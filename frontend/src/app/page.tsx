"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTelegramApp } from "@/hooks/useTelegramApp";

export default function Home() {
	const router = useRouter();
	const isTelegramApp = useTelegramApp(true);

	useEffect(() => {
		// If we're in Telegram environment, redirect to app
		if (isTelegramApp) {
			router.replace("/app");
		}
	}, [isTelegramApp, router]);

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
