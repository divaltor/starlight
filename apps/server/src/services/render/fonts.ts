import { GlobalFonts } from "@napi-rs/canvas";
import { logger } from "@/logger";

let fontsRegistered = false;

const UNICODE_FALLBACK_FAMILY = "Noto Sans";
const CJK_FONT_FAMILY = "Noto Sans CJK";
const MATH_FONT_FAMILY = "Noto Sans Math";
const EMOJI_FONT_FAMILY = "Noto Color Emoji";

export function registerFonts(): void {
	if (fontsRegistered) {
		return;
	}

	try {
		const fontPath = `${process.cwd()}/assets/fonts`;

		GlobalFonts.registerFromPath(`${fontPath}/Inter-Regular.ttf`, "Inter");

		GlobalFonts.registerFromPath(`${fontPath}/Inter-Bold.ttf`, "Inter");

		GlobalFonts.registerFromPath(`${fontPath}/NotoSans-Regular.ttf`, UNICODE_FALLBACK_FAMILY);

		GlobalFonts.registerFromPath(`${fontPath}/NotoSansCJKsc-Regular.otf`, CJK_FONT_FAMILY);

		GlobalFonts.registerFromPath(`${fontPath}/NotoSansMath-Regular.ttf`, MATH_FONT_FAMILY);

		GlobalFonts.registerFromPath(`${fontPath}/NotoColorEmoji.ttf`, EMOJI_FONT_FAMILY);

		fontsRegistered = true;
		logger.info("Registered Inter, Noto Sans, Noto Sans CJK, Noto Sans Math, and emoji fonts");
	} catch {
		logger.warn("Could not register fonts, using system fallback");
		fontsRegistered = true;
	}
}

export function getFontFamily(): string {
	return `Inter, '${UNICODE_FALLBACK_FAMILY}', '${CJK_FONT_FAMILY}', '${MATH_FONT_FAMILY}', '${EMOJI_FONT_FAMILY}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
}
