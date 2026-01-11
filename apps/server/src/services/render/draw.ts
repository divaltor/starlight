import type { Image, SKRSContext2D } from "@napi-rs/canvas";

type RoundedRectParams = {
	ctx: SKRSContext2D;
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
};

export function roundedRect(params: RoundedRectParams): void {
	const { ctx, x, y, width, height, radius } = params;
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + width - radius, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
	ctx.lineTo(x + width, y + height - radius);
	ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
	ctx.lineTo(x + radius, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
}

type DrawCircularImageParams = {
	ctx: SKRSContext2D;
	image: Image;
	x: number;
	y: number;
	size: number;
};

export function drawCircularImage(params: DrawCircularImageParams): void {
	const { ctx, image, x, y, size } = params;
	ctx.save();
	ctx.beginPath();
	ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
	ctx.closePath();
	ctx.clip();
	ctx.drawImage(image, x, y, size, size);
	ctx.restore();
}

export function wrapText(
	ctx: SKRSContext2D,
	text: string,
	maxWidth: number
): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let currentLine = "";

	for (const word of words) {
		const testLine = currentLine ? `${currentLine} ${word}` : word;
		const metrics = ctx.measureText(testLine);

		if (metrics.width > maxWidth && currentLine) {
			lines.push(currentLine);
			currentLine = word;
		} else {
			currentLine = testLine;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

// biome-ignore lint/style/useNumericSeparators: conflicting rule with 4-digit numbers
const ONE_MILLION = 1_000_000;
const ONE_THOUSAND = 1000;

export function formatNumber(num: number | null | undefined): string {
	if (num == null) {
		return "0";
	}
	if (num >= ONE_MILLION) {
		return `${(num / ONE_MILLION).toFixed(1)}M`;
	}
	if (num >= ONE_THOUSAND) {
		return `${(num / ONE_THOUSAND).toFixed(1)}K`;
	}
	return num.toString();
}
