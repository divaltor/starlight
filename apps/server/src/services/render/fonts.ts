import { GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { logger } from "@/logger";

let fontsRegistered = false;

const EMOJI_FONT_FAMILY = "Noto Color Emoji";
const UNICODE_FALLBACK_FAMILY = "Noto Sans";
const TAGALOG_FONT_FAMILY = "Noto Sans Tagalog";
const SYMBOLS_FONT_FAMILY = "Noto Sans Symbols 2";

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
			path.join(fontPath, "NotoSans-Regular.ttf"),
			UNICODE_FALLBACK_FAMILY
		);

		GlobalFonts.registerFromPath(
			path.join(fontPath, "NotoSansTagalog-Regular.ttf"),
			TAGALOG_FONT_FAMILY
		);

		GlobalFonts.registerFromPath(
			path.join(fontPath, "NotoSansSymbols2-Regular.ttf"),
			SYMBOLS_FONT_FAMILY
		);

		GlobalFonts.registerFromPath(
			path.join(fontPath, "NotoColorEmoji.ttf"),
			EMOJI_FONT_FAMILY
		);

		fontsRegistered = true;
		logger.info(
			"Registered Inter, Noto Sans Unicode fallback, symbols, and emoji fonts"
		);
	} catch {
		logger.warn("Could not register fonts, using system fallback");
		fontsRegistered = true;
	}
}

export function getFontFamily(): string {
	return `Inter, '${UNICODE_FALLBACK_FAMILY}', '${TAGALOG_FONT_FAMILY}', '${SYMBOLS_FONT_FAMILY}', '${EMOJI_FONT_FAMILY}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
}
