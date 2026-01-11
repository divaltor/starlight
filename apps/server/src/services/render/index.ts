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
	quote?: TweetData | null;
	replyChain?: TweetData[];
	hasMoreInChain?: boolean;
};

export type RenderResult = {
	buffer: Buffer;
	width: number;
	height: number;
};

const MAX_MEDIA_HEIGHT = 400;
const QUOTE_MAX_MEDIA_HEIGHT = 200;
const QUOTE_AVATAR_SIZE = 24;
const QUOTE_FONT_SIZE_NAME = 13;
const QUOTE_FONT_SIZE_TEXT = 14;
const QUOTE_PADDING = 12;
const QUOTE_BORDER_WIDTH = 1;

const REPLY_AVATAR_SIZE = 32;
const REPLY_FONT_SIZE_NAME = 13;
const REPLY_FONT_SIZE_TEXT = 14;
const REPLY_LINE_WIDTH = 2;
const DOTS_INDICATOR_HEIGHT = 24;
const DOT_SIZE = 4;
const DOT_GAP = 6;

type ReplyChainItem = {
	tweet: TweetData;
	textLines: ReturnType<typeof wrapText>;
	height: number;
};

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
	const textHeight = Math.floor(
		textLines.length * LAYOUT.FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT +
			paragraphCount * LAYOUT.PARAGRAPH_GAP
	);

	let mediaHeight = 0;
	const photos = tweet.media?.photos;
	if (photos && photos.length > 0) {
		const firstPhoto = photos.at(0);
		if (firstPhoto) {
			const aspectRatio = firstPhoto.width / firstPhoto.height;
			const computedHeight = contentWidth / aspectRatio;
			mediaHeight = Math.floor(Math.min(computedHeight, MAX_MEDIA_HEIGHT));
		}
	}

	let quoteHeight = 0;
	let quoteTextLines: ReturnType<typeof wrapText> = [];
	let quoteMediaHeight = 0;
	const quoteContentWidth = contentWidth - QUOTE_PADDING * 2;
	if (tweet.quote) {
		measureCtx.font = `${QUOTE_FONT_SIZE_TEXT}px ${fontFamily}`;
		quoteTextLines = wrapText(
			measureCtx,
			tweet.quote.text,
			quoteContentWidth - QUOTE_AVATAR_SIZE - LAYOUT.AVATAR_GAP
		);
		const quoteParagraphCount = quoteTextLines.filter(
			(line) => line.isParagraphEnd
		).length;
		const quoteTextHeight =
			quoteTextLines.length * QUOTE_FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT +
			quoteParagraphCount * LAYOUT.PARAGRAPH_GAP;

		const quotePhotos = tweet.quote.media?.photos;
		if (quotePhotos && quotePhotos.length > 0) {
			const firstQuotePhoto = quotePhotos.at(0);
			if (firstQuotePhoto) {
				const aspectRatio = firstQuotePhoto.width / firstQuotePhoto.height;
				const computedHeight = quoteContentWidth / aspectRatio;
				quoteMediaHeight = Math.floor(
					Math.min(computedHeight, QUOTE_MAX_MEDIA_HEIGHT)
				);
			}
		}

		quoteHeight = Math.floor(
			QUOTE_PADDING * 2 +
				Math.max(
					QUOTE_AVATAR_SIZE,
					QUOTE_FONT_SIZE_NAME + 4 + quoteTextHeight
				) +
				(quoteMediaHeight > 0 ? LAYOUT.AVATAR_GAP + quoteMediaHeight : 0)
		);
	}

	const replyChainItems: ReplyChainItem[] = [];
	const replyToTextX = LAYOUT.PADDING + REPLY_AVATAR_SIZE + LAYOUT.AVATAR_GAP;
	const replyToTextWidth = contentWidth - REPLY_AVATAR_SIZE - LAYOUT.AVATAR_GAP;
	let totalReplyChainHeight = 0;

	if (tweet.replyChain && tweet.replyChain.length > 0) {
		if (tweet.hasMoreInChain) {
			totalReplyChainHeight += DOTS_INDICATOR_HEIGHT;
		}

		for (const chainTweet of tweet.replyChain) {
			measureCtx.font = `${REPLY_FONT_SIZE_TEXT}px ${fontFamily}`;
			const textLines = wrapText(measureCtx, chainTweet.text, replyToTextWidth);
			const paragraphCount = textLines.filter(
				(line) => line.isParagraphEnd
			).length;
			const textHeight =
				textLines.length * REPLY_FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT +
				paragraphCount * LAYOUT.PARAGRAPH_GAP;
			const itemHeight = Math.floor(
				REPLY_AVATAR_SIZE +
					LAYOUT.AVATAR_GAP +
					Math.max(
						0,
						textHeight - REPLY_AVATAR_SIZE + REPLY_FONT_SIZE_NAME + 4
					) +
					LAYOUT.AVATAR_GAP
			);

			replyChainItems.push({
				tweet: chainTweet,
				textLines,
				height: itemHeight,
			});
			totalReplyChainHeight += itemHeight;
		}
	}

	const headerHeight = LAYOUT.AVATAR_SIZE;
	const statsHeight = 30;
	const totalHeight =
		LAYOUT.PADDING +
		totalReplyChainHeight +
		headerHeight +
		LAYOUT.AVATAR_GAP +
		textHeight +
		(mediaHeight > 0 ? LAYOUT.AVATAR_GAP + mediaHeight : 0) +
		(quoteHeight > 0 ? LAYOUT.AVATAR_GAP + quoteHeight : 0) +
		LAYOUT.AVATAR_GAP +
		statsHeight +
		LAYOUT.PADDING;

	const canvas = createCanvas(LAYOUT.WIDTH, totalHeight);
	const ctx = canvas.getContext("2d");

	const cardRadius = LAYOUT.MEDIA_BORDER_RADIUS;

	ctx.fillStyle = colors.cardBackground;
	roundedRect({
		ctx,
		x: 0,
		y: 0,
		width: LAYOUT.WIDTH,
		height: totalHeight,
		radius: cardRadius,
	});
	ctx.fill();

	ctx.strokeStyle = colors.border;
	ctx.lineWidth = 1;
	roundedRect({
		ctx,
		x: 0.5,
		y: 0.5,
		width: LAYOUT.WIDTH - 1,
		height: totalHeight - 1,
		radius: cardRadius,
	});
	ctx.stroke();

	let yOffset = LAYOUT.PADDING;
	const replyAvatarCenterX = LAYOUT.PADDING + REPLY_AVATAR_SIZE / 2;

	if (replyChainItems.length > 0) {
		if (tweet.hasMoreInChain) {
			ctx.fillStyle = colors.secondaryText;
			for (let i = 0; i < 3; i++) {
				ctx.beginPath();
				ctx.arc(
					replyAvatarCenterX,
					yOffset + DOTS_INDICATOR_HEIGHT / 2 + (i - 1) * (DOT_SIZE + DOT_GAP),
					DOT_SIZE / 2,
					0,
					Math.PI * 2
				);
				ctx.fill();
			}
			yOffset += DOTS_INDICATOR_HEIGHT;
		}

		for (const item of replyChainItems) {
			try {
				const replyAvatar = await loadImage(item.tweet.authorAvatarUrl);
				drawCircularImage({
					ctx,
					image: replyAvatar,
					x: LAYOUT.PADDING,
					y: yOffset,
					size: REPLY_AVATAR_SIZE,
				});
			} catch (error) {
				logger.warn(
					{ error, url: item.tweet.authorAvatarUrl },
					"Failed to load reply avatar"
				);
				ctx.fillStyle = colors.secondaryText;
				ctx.beginPath();
				ctx.arc(
					replyAvatarCenterX,
					yOffset + REPLY_AVATAR_SIZE / 2,
					REPLY_AVATAR_SIZE / 2,
					0,
					Math.PI * 2
				);
				ctx.fill();
			}

			ctx.fillStyle = colors.text;
			ctx.font = `bold ${REPLY_FONT_SIZE_NAME}px ${fontFamily}`;
			ctx.fillText(
				item.tweet.authorName,
				replyToTextX,
				yOffset + REPLY_FONT_SIZE_NAME
			);

			ctx.fillStyle = colors.secondaryText;
			ctx.font = `${REPLY_FONT_SIZE_NAME}px ${fontFamily}`;
			const replyNameWidth = ctx.measureText(item.tweet.authorName).width;
			ctx.fillText(
				` @${item.tweet.authorUsername}`,
				replyToTextX + replyNameWidth,
				yOffset + REPLY_FONT_SIZE_NAME
			);

			let replyTextY = yOffset + REPLY_FONT_SIZE_NAME + 4;

			ctx.fillStyle = colors.text;
			ctx.font = `${REPLY_FONT_SIZE_TEXT}px ${fontFamily}`;
			for (const line of item.textLines) {
				ctx.fillText(
					line.text,
					replyToTextX,
					replyTextY + REPLY_FONT_SIZE_TEXT
				);
				replyTextY += REPLY_FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT;
				if (line.isParagraphEnd) {
					replyTextY += LAYOUT.PARAGRAPH_GAP;
				}
			}

			const lineStartY = yOffset + REPLY_AVATAR_SIZE;
			const lineEndY = yOffset + item.height - LAYOUT.AVATAR_GAP / 2;

			ctx.strokeStyle = colors.border;
			ctx.lineWidth = REPLY_LINE_WIDTH;
			ctx.beginPath();
			ctx.moveTo(replyAvatarCenterX, lineStartY);
			ctx.lineTo(replyAvatarCenterX, lineEndY);
			ctx.stroke();

			yOffset += item.height;
		}
	}

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

				ctx.fillStyle = colors.background;
				ctx.fillRect(LAYOUT.PADDING, yOffset, contentWidth, mediaHeight);

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

	if (tweet.quote && quoteHeight > 0) {
		yOffset += LAYOUT.AVATAR_GAP;

		ctx.strokeStyle = colors.border;
		ctx.lineWidth = QUOTE_BORDER_WIDTH;
		roundedRect({
			ctx,
			x: LAYOUT.PADDING,
			y: yOffset,
			width: contentWidth,
			height: quoteHeight,
			radius: LAYOUT.MEDIA_BORDER_RADIUS,
		});
		ctx.stroke();

		const quoteX = LAYOUT.PADDING + QUOTE_PADDING;
		const quoteTextX = quoteX + QUOTE_AVATAR_SIZE + LAYOUT.AVATAR_GAP;
		let quoteY = yOffset + QUOTE_PADDING;

		try {
			const quoteAvatar = await loadImage(tweet.quote.authorAvatarUrl);
			drawCircularImage({
				ctx,
				image: quoteAvatar,
				x: quoteX,
				y: quoteY,
				size: QUOTE_AVATAR_SIZE,
			});
		} catch (error) {
			logger.warn(
				{ error, url: tweet.quote.authorAvatarUrl },
				"Failed to load quote avatar"
			);
			ctx.fillStyle = colors.secondaryText;
			ctx.beginPath();
			ctx.arc(
				quoteX + QUOTE_AVATAR_SIZE / 2,
				quoteY + QUOTE_AVATAR_SIZE / 2,
				QUOTE_AVATAR_SIZE / 2,
				0,
				Math.PI * 2
			);
			ctx.fill();
		}

		ctx.fillStyle = colors.text;
		ctx.font = `bold ${QUOTE_FONT_SIZE_NAME}px ${fontFamily}`;
		const nameWidth = ctx.measureText(tweet.quote.authorName).width;
		ctx.fillText(
			tweet.quote.authorName,
			quoteTextX,
			quoteY + QUOTE_FONT_SIZE_NAME
		);

		ctx.fillStyle = colors.secondaryText;
		ctx.font = `${QUOTE_FONT_SIZE_NAME}px ${fontFamily}`;
		ctx.fillText(
			` @${tweet.quote.authorUsername}`,
			quoteTextX + nameWidth,
			quoteY + QUOTE_FONT_SIZE_NAME
		);

		quoteY += QUOTE_FONT_SIZE_NAME + 4;

		ctx.fillStyle = colors.text;
		ctx.font = `${QUOTE_FONT_SIZE_TEXT}px ${fontFamily}`;
		for (const line of quoteTextLines) {
			ctx.fillText(line.text, quoteTextX, quoteY + QUOTE_FONT_SIZE_TEXT);
			quoteY += QUOTE_FONT_SIZE_TEXT * LAYOUT.LINE_HEIGHT;
			if (line.isParagraphEnd) {
				quoteY += LAYOUT.PARAGRAPH_GAP;
			}
		}

		const quotePhotos = tweet.quote.media?.photos;
		if (quotePhotos && quotePhotos.length > 0 && quoteMediaHeight > 0) {
			quoteY += LAYOUT.AVATAR_GAP;

			try {
				const firstQuotePhoto = quotePhotos.at(0);
				if (firstQuotePhoto) {
					const quoteImage = await loadImage(firstQuotePhoto.url);

					ctx.save();
					roundedRect({
						ctx,
						x: quoteX,
						y: quoteY,
						width: quoteContentWidth,
						height: quoteMediaHeight,
						radius: LAYOUT.MEDIA_BORDER_RADIUS,
					});
					ctx.clip();

					ctx.fillStyle = colors.background;
					ctx.fillRect(quoteX, quoteY, quoteContentWidth, quoteMediaHeight);

					ctx.drawImage(
						quoteImage,
						quoteX,
						quoteY,
						quoteContentWidth,
						quoteMediaHeight
					);
					ctx.restore();
				}
			} catch (error) {
				logger.warn({ error }, "Failed to load quote media image");
			}
		}

		yOffset += quoteHeight;
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

	const buffer = canvas.toBuffer("image/jpeg", 100);

	logger.debug(
		{ width: LAYOUT.WIDTH, height: totalHeight, size: buffer.length },
		"Rendered tweet image"
	);

	return {
		buffer,
		width: LAYOUT.WIDTH,
		height: totalHeight,
	};
}
