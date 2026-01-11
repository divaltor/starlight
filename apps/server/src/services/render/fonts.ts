import { GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { logger } from "@/logger";

let fontsRegistered = false;

const EMOJI_FONT_FAMILY = "Noto Color Emoji";

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

		GlobalFonts.registerFromPath(
			path.join(fontPath, "NotoColorEmoji.ttf"),
			EMOJI_FONT_FAMILY
		);

		fontsRegistered = true;
		logger.info("Registered Inter and emoji fonts");
	} catch {
		logger.warn("Could not register fonts, using system fallback");
		fontsRegistered = true;
	}
}

export function getFontFamily(): string {
	return `Inter, '${EMOJI_FONT_FAMILY}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
}
