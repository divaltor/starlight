import { GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { logger } from "@/logger";

let fontsRegistered = false;

export function registerFonts(): void {
	if (fontsRegistered) {
		return;
	}

	try {
		const fontPath = path.join(process.cwd(), "assets", "fonts");

		GlobalFonts.registerFromPath(
			path.join(fontPath, "Inter-Regular.ttf"),
			"Inter"
		);

		GlobalFonts.registerFromPath(
			path.join(fontPath, "Inter-Bold.ttf"),
			"Inter"
		);

		fontsRegistered = true;
		logger.info("Registered Inter fonts");
	} catch {
		logger.warn("Could not register Inter fonts, using system fallback");
		fontsRegistered = true;
	}
}

export function getFontFamily(): string {
	return "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
}
