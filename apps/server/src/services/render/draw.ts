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
	drawImageCover({ ctx, image, x, y, width: size, height: size });
	ctx.restore();
}

type DrawImageCoverParams = {
	ctx: SKRSContext2D;
	image: Image;
	x: number;
	y: number;
	width: number;
	height: number;
};

export function drawImageCover(params: DrawImageCoverParams): void {
	const {
		ctx,
		image,
		x: destX,
		y: destY,
		width: destWidth,
		height: destHeight,
	} = params;
	const srcWidth = image.width;
	const srcHeight = image.height;

	const srcAspect = srcWidth / srcHeight;
	const destAspect = destWidth / destHeight;

	let cropX = 0;
	let cropY = 0;
	let cropWidth = srcWidth;
	let cropHeight = srcHeight;

	if (srcAspect > destAspect) {
		cropWidth = srcHeight * destAspect;
		cropX = (srcWidth - cropWidth) / 2;
	} else {
		cropHeight = srcWidth / destAspect;
		cropY = (srcHeight - cropHeight) / 2;
	}

	ctx.drawImage(
		image,
		cropX,
		cropY,
		cropWidth,
		cropHeight,
		destX,
		destY,
		destWidth,
		destHeight
	);
}

export type TextLine = {
	text: string;
	isParagraphEnd: boolean;
};

function isHashtagLine(text: string): boolean {
	const words = text.trim().split(/\s+/);
	return words.length > 0 && words.every((word) => word.startsWith("#"));
}

export function wrapText(
	ctx: SKRSContext2D,
	text: string,
	maxWidth: number
): TextLine[] {
	const normalizedText = text.replace(/\n(#\S+(\s+#\S+)*\s*)$/, "\n\n$1");
	const paragraphs = normalizedText.split(/\n\n+/);
	const lines: TextLine[] = [];

	for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
		const rawParagraph = paragraphs[pIndex];
		if (!rawParagraph) {
			continue;
		}

		const explicitLines = rawParagraph.split(/\n/);

		for (let lineIndex = 0; lineIndex < explicitLines.length; lineIndex++) {
			const explicitLine = explicitLines[lineIndex]?.trim();
			if (!explicitLine) {
				continue;
			}

			const words = explicitLine.split(/\s+/);
			let currentLine = "";

			for (const word of words) {
				const testLine = currentLine ? `${currentLine} ${word}` : word;
				const metrics = ctx.measureText(testLine);

				if (metrics.width > maxWidth && currentLine) {
					lines.push({ text: currentLine, isParagraphEnd: false });
					currentLine = word;
				} else {
					currentLine = testLine;
				}
			}

			if (currentLine) {
				const isLastParagraph = pIndex === paragraphs.length - 1;
				const isLastLineInParagraph = lineIndex === explicitLines.length - 1;
				lines.push({
					text: currentLine,
					isParagraphEnd: isLastLineInParagraph && !isLastParagraph,
				});
			}
		}
	}

	let firstHashtagLineIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line && isHashtagLine(line.text)) {
			firstHashtagLineIndex = i;
			break;
		}
	}

	if (firstHashtagLineIndex > 0) {
		const prevLine = lines[firstHashtagLineIndex - 1];
		if (prevLine && !prevLine.isParagraphEnd) {
			prevLine.isParagraphEnd = true;
		}
	}

	return lines;
}

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

type DrawPlayButtonParams = {
	ctx: SKRSContext2D;
	centerX: number;
	centerY: number;
	size?: number;
};

export function drawPlayButton(params: DrawPlayButtonParams): void {
	const { ctx, centerX, centerY, size = 48 } = params;

	ctx.save();

	ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
	ctx.beginPath();
	ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
	ctx.fill();

	ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
	ctx.stroke();

	const triangleSize = size * 0.4;
	const offsetX = triangleSize * 0.15;
	ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
	ctx.beginPath();
	ctx.moveTo(centerX - triangleSize / 2 + offsetX, centerY - triangleSize / 2);
	ctx.lineTo(centerX + triangleSize / 2 + offsetX, centerY);
	ctx.lineTo(centerX - triangleSize / 2 + offsetX, centerY + triangleSize / 2);
	ctx.closePath();
	ctx.fill();

	ctx.restore();
}
