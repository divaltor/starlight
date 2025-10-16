import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import { initTMA } from "@/lib/init";
import { mockEnv } from "@/lib/mockEnv";

// One-time TMA initialization on client hydration
async function initializeClient() {
	try {
		// Set up mock environment for development
		await mockEnv();

		// Initialize TMA with all components
		await initTMA();

		console.log("✅ TMA client initialization completed");
	} catch (error) {
		console.error("❌ TMA client initialization failed:", error);
	}
}

// Initialize TMA before hydrating
initializeClient();

hydrateRoot(document, <StartClient />);
