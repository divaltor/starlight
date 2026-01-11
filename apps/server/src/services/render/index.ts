import { createCanvas, loadImage } from "@napi-rs/canvas";
import { logger } from "@/logger";
import { drawCircularImage, formatNumber, roundedRect, wrapText } from "./draw";
import { getFontFamily, registerFonts } from "./fonts";
import { LAYOUT } from "./layout";
import { type Theme, themes } from "./themes";

export type { Theme } from "./themes";

export type TweetData = {
	authorName: string;
	authorUsername: string;
	authorAvatarUrl: string;
	text: string;
	media?: {
		photos?: Array<{ url: string; width: number; height: number }>;
	} | null;
	likes?: number | null;
	retweets?: number | null;
	replies?: number | null;
};

export type RenderResult = {
	buffer: Buffer;
	width: number;
	height: number;
};

const MAX_MEDIA_HEIGHT = 400;

export async function renderTweetImage(
	tweet: TweetData,
	theme: Theme
): Promise<RenderResult> {
	registerFonts();

	const colors = themes[theme];
	const fontFamily = getFontFamily();

	const contentWidth = LAYOUT.WIDTH - LAYOUT.PADDING * 2;
	const textX = LAYOUT.PADDING + LAYOUT.AVATAR_SIZE + LAYOUT.AVATAR_GAP;
	const textWidth = contentWidth - LAYOUT.AVATAR_SIZE - LAYOUT.AVATAR_GAP;

	const measureCanvas = createCanvas(LAYOUT.WIDTH, 100);
	const measureCtx = measureCanvas.getContext("2d");
	measureCtx.font = `${LAYOUT.FONT_SIZE_TEXT}px ${fontFamily}`;

	const textLines = wrapText(measureCtx, tweet.text, textWidth);
	const paragraphCount = textLines.filter((line) => line.isParagraphEnd).length;
	const textHeight =
		textLines.length * LAYOUT.FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT +
		paragraphCount * LAYOUT.PARAGRAPH_GAP;

	let mediaHeight = 0;
	const photos = tweet.media?.photos;
	if (photos && photos.length > 0) {
		const firstPhoto = photos.at(0);
		if (firstPhoto) {
			const aspectRatio = firstPhoto.width / firstPhoto.height;
			const computedHeight = contentWidth / aspectRatio;
			mediaHeight = Math.min(computedHeight, MAX_MEDIA_HEIGHT);
		}
	}

	const headerHeight = LAYOUT.AVATAR_SIZE;
	const statsHeight = 30;
	const totalHeight =
		LAYOUT.PADDING +
		headerHeight +
		LAYOUT.AVATAR_GAP +
		textHeight +
		(mediaHeight > 0 ? LAYOUT.AVATAR_GAP + mediaHeight : 0) +
		LAYOUT.AVATAR_GAP +
		statsHeight +
		LAYOUT.PADDING;

	const canvas = createCanvas(LAYOUT.WIDTH, totalHeight);
	const ctx = canvas.getContext("2d");

	ctx.fillStyle = colors.cardBackground;
	ctx.fillRect(0, 0, LAYOUT.WIDTH, totalHeight);

	ctx.strokeStyle = colors.border;
	ctx.lineWidth = 1;
	ctx.strokeRect(0.5, 0.5, LAYOUT.WIDTH - 1, totalHeight - 1);

	let yOffset = LAYOUT.PADDING;

	try {
		const avatar = await loadImage(tweet.authorAvatarUrl);
		drawCircularImage({
			ctx,
			image: avatar,
			x: LAYOUT.PADDING,
			y: yOffset,
			size: LAYOUT.AVATAR_SIZE,
		});
	} catch (error) {
		logger.warn({ error, url: tweet.authorAvatarUrl }, "Failed to load avatar");
		ctx.fillStyle = colors.secondaryText;
		ctx.beginPath();
		ctx.arc(
			LAYOUT.PADDING + LAYOUT.AVATAR_SIZE / 2,
			yOffset + LAYOUT.AVATAR_SIZE / 2,
			LAYOUT.AVATAR_SIZE / 2,
			0,
			Math.PI * 2
		);
		ctx.fill();
	}

	ctx.fillStyle = colors.text;
	ctx.font = `bold ${LAYOUT.FONT_SIZE_NAME}px ${fontFamily}`;
	ctx.fillText(tweet.authorName, textX, yOffset + 18);

	ctx.fillStyle = colors.secondaryText;
	ctx.font = `${LAYOUT.FONT_SIZE_USERNAME}px ${fontFamily}`;
	ctx.fillText(`@${tweet.authorUsername}`, textX, yOffset + 38);

	yOffset += headerHeight + LAYOUT.AVATAR_GAP;

	ctx.fillStyle = colors.text;
	ctx.font = `${LAYOUT.FONT_SIZE_TEXT}px ${fontFamily}`;

	for (const line of textLines) {
		ctx.fillText(line.text, LAYOUT.PADDING, yOffset + LAYOUT.FONT_SIZE_TEXT);
		yOffset += LAYOUT.FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT;
		if (line.isParagraphEnd) {
			yOffset += LAYOUT.PARAGRAPH_GAP;
		}
	}

	if (photos && photos.length > 0 && mediaHeight > 0) {
		yOffset += LAYOUT.AVATAR_GAP;

		try {
			const firstPhoto = photos.at(0);
			if (firstPhoto) {
				const image = await loadImage(firstPhoto.url);

				ctx.save();
				roundedRect({
					ctx,
					x: LAYOUT.PADDING,
					y: yOffset,
					width: contentWidth,
					height: mediaHeight,
					radius: LAYOUT.MEDIA_BORDER_RADIUS,
				});
				ctx.clip();

				ctx.drawImage(
					image,
					LAYOUT.PADDING,
					yOffset,
					contentWidth,
					mediaHeight
				);
				ctx.restore();

				yOffset += mediaHeight;
			}
		} catch (error) {
			logger.warn({ error }, "Failed to load media image");
		}
	}

	yOffset += LAYOUT.AVATAR_GAP;

	ctx.fillStyle = colors.secondaryText;
	ctx.font = `${LAYOUT.FONT_SIZE_STATS}px ${fontFamily}`;

	const stats = [
		`${formatNumber(tweet.replies)} replies`,
		`${formatNumber(tweet.retweets)} reposts`,
		`${formatNumber(tweet.likes)} likes`,
	];

	ctx.fillText(
		stats.join("  ·  "),
		LAYOUT.PADDING,
		yOffset + LAYOUT.FONT_SIZE_STATS
	);

	return {
		buffer: canvas.toBuffer("image/jpeg", 95),
		width: LAYOUT.WIDTH,
		height: totalHeight,
	};
}
