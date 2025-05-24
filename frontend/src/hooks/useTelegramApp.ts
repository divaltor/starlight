import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isTMA } from "@telegram-apps/bridge";

/**
 * Custom hook to validate if the app is running in Telegram Mini Apps environment
 * Redirects to /not-found if not in Telegram (unless disabled)
 * Use enabled=false for pages like 404 that should be accessible outside Telegram
 */
export function useTelegramApp(enabled = true) {
	const router = useRouter();

	useEffect(() => {
		if (!enabled) return;

		try {
			// Use Telegram Mini Apps detection
			const isInTelegram = isTMA("complete");

			if (!isInTelegram) {
				console.log(
					"Not in Telegram Mini Apps environment, redirecting to /not-found",
				);
				router.replace("/not-found");
			} else {
				console.log("Telegram Mini Apps environment detected");
			}
		} catch (error) {
			console.error("Error checking Telegram environment:", error);
			// If there's an error with isTMA, assume we're not in Telegram
			router.replace("/not-found");
		}
	}, [router, enabled]);

	// Return the current status (safe to call even if not mounted)
	try {
		return isTMA("complete");
	} catch {
		return false;
	}
}
