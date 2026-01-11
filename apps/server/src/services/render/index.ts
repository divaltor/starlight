import { createCanvas, loadImage } from "@napi-rs/canvas";
import { format } from "date-fns";
import { logger } from "@/logger";
import {
	drawCircularImage,
	drawPlayButton,
	formatNumber,
	roundedRect,
	wrapText,
} from "./draw";
import { getFontFamily, registerFonts } from "./fonts";
import { LAYOUT } from "./layout";
import { type Theme, themes } from "./themes";

export type { Theme } from "./themes";

export type TweetData = {
	authorName: string;
	authorUsername: string;
	authorAvatarUrl: string;
	text: string;
	createdAt?: Date | null;
	media?: {
		photos?: Array<{ url: string; width: number; height: number }>;
		videos?: Array<{
			thumbnailUrl: string;
			width: number;
			height: number;
			type: "video" | "gif";
		}>;
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

const QUOTE_AVATAR_SIZE = 24;
const QUOTE_FONT_SIZE_NAME = 13;
const QUOTE_FONT_SIZE_TEXT = 14;
const QUOTE_PADDING = 12;
const QUOTE_BORDER_WIDTH = 1;

const REPLY_AVATAR_SIZE = LAYOUT.AVATAR_SIZE;
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
	mediaHeight: number;
	isVideo: boolean;
};

type MediaItem =
	| { type: "photo"; url: string; width: number; height: number }
	| {
			type: "video" | "gif";
			thumbnailUrl: string;
			width: number;
			height: number;
	  };

function getFirstMedia(media: TweetData["media"]): MediaItem | null {
	if (!media) {
		return null;
	}

	const firstPhoto = media.photos?.at(0);
	if (firstPhoto) {
		return { type: "photo", ...firstPhoto };
	}

	const firstVideo = media.videos?.at(0);
	if (firstVideo) {
		return firstVideo;
	}

	return null;
}

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
	let mainMediaIsVideo = false;
	const mainMedia = getFirstMedia(tweet.media);
	if (mainMedia) {
		const aspectRatio = mainMedia.width / mainMedia.height;
		mediaHeight = Math.floor(contentWidth / aspectRatio);
		mainMediaIsVideo = mainMedia.type === "video" || mainMedia.type === "gif";
	}

	let quoteHeight = 0;
	let quoteTextLines: ReturnType<typeof wrapText> = [];
	let quoteMediaHeight = 0;
	let quoteMediaIsVideo = false;
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

		const quoteMedia = getFirstMedia(tweet.quote.media);
		if (quoteMedia) {
			const aspectRatio = quoteMedia.width / quoteMedia.height;
			quoteMediaHeight = Math.floor(quoteContentWidth / aspectRatio);
			quoteMediaIsVideo =
				quoteMedia.type === "video" || quoteMedia.type === "gif";
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

			let chainMediaHeight = 0;
			let chainMediaIsVideo = false;
			const chainMedia = getFirstMedia(chainTweet.media);
			if (chainMedia) {
				const aspectRatio = chainMedia.width / chainMedia.height;
				chainMediaHeight = Math.floor(replyToTextWidth / aspectRatio);
				chainMediaIsVideo =
					chainMedia.type === "video" || chainMedia.type === "gif";
			}

			const itemHeight = Math.floor(
				REPLY_AVATAR_SIZE +
					LAYOUT.AVATAR_GAP +
					Math.max(
						0,
						textHeight - REPLY_AVATAR_SIZE + REPLY_FONT_SIZE_NAME + 4
					) +
					(chainMediaHeight > 0
						? LAYOUT.AVATAR_GAP + chainMediaHeight + LAYOUT.MEDIA_GAP_BOTTOM
						: LAYOUT.AVATAR_GAP)
			);

			replyChainItems.push({
				tweet: chainTweet,
				textLines,
				height: itemHeight,
				mediaHeight: chainMediaHeight,
				isVideo: chainMediaIsVideo,
			});
			totalReplyChainHeight += itemHeight;
		}
	}

	const headerHeight = LAYOUT.AVATAR_SIZE;
	const statsHeight = 30;
	const mediaGapAfter = LAYOUT.MEDIA_GAP_BOTTOM;
	const totalHeight =
		LAYOUT.PADDING +
		totalReplyChainHeight +
		headerHeight +
		LAYOUT.AVATAR_GAP +
		textHeight +
		(mediaHeight > 0 ? LAYOUT.AVATAR_GAP + mediaHeight + mediaGapAfter : 0) +
		(quoteHeight > 0
			? (mediaHeight > 0 ? 0 : LAYOUT.AVATAR_GAP) + quoteHeight
			: 0) +
		(mediaHeight === 0 && quoteHeight === 0 ? LAYOUT.AVATAR_GAP : 0) +
		statsHeight +
		LAYOUT.PADDING;

	const scale = LAYOUT.SCALE_FACTOR;
	const canvas = createCanvas(LAYOUT.WIDTH * scale, totalHeight * scale);
	const ctx = canvas.getContext("2d");
	ctx.scale(scale, scale);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

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

			const chainMedia = getFirstMedia(item.tweet.media);
			if (chainMedia && item.mediaHeight > 0) {
				replyTextY += LAYOUT.AVATAR_GAP;

				try {
					const chainImageUrl =
						chainMedia.type === "photo"
							? chainMedia.url
							: chainMedia.thumbnailUrl;
					const chainImage = await loadImage(chainImageUrl);

					ctx.save();
					roundedRect({
						ctx,
						x: replyToTextX,
						y: replyTextY,
						width: replyToTextWidth,
						height: item.mediaHeight,
						radius: LAYOUT.MEDIA_BORDER_RADIUS,
					});
					ctx.clip();

					ctx.fillStyle = colors.background;
					ctx.fillRect(
						replyToTextX,
						replyTextY,
						replyToTextWidth,
						item.mediaHeight
					);

					ctx.drawImage(
						chainImage,
						replyToTextX,
						replyTextY,
						replyToTextWidth,
						item.mediaHeight
					);
					ctx.restore();

					if (item.isVideo) {
						drawPlayButton({
							ctx,
							centerX: replyToTextX + replyToTextWidth / 2,
							centerY: replyTextY + item.mediaHeight / 2,
						});
					}
				} catch (error) {
					logger.warn({ error }, "Failed to load reply chain media image");
				}
			}

			const lineMargin = 4;
			const lineStartY = yOffset + REPLY_AVATAR_SIZE + lineMargin;
			const bottomGap =
				item.mediaHeight > 0 ? LAYOUT.MEDIA_GAP_BOTTOM : LAYOUT.AVATAR_GAP;
			const lineEndY = yOffset + item.height - bottomGap / 2;

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

	if (mainMedia && mediaHeight > 0) {
		yOffset += LAYOUT.AVATAR_GAP;

		try {
			const imageUrl =
				mainMedia.type === "photo" ? mainMedia.url : mainMedia.thumbnailUrl;
			const image = await loadImage(imageUrl);

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

			ctx.drawImage(image, LAYOUT.PADDING, yOffset, contentWidth, mediaHeight);
			ctx.restore();

			if (mainMediaIsVideo) {
				drawPlayButton({
					ctx,
					centerX: LAYOUT.PADDING + contentWidth / 2,
					centerY: yOffset + mediaHeight / 2,
				});
			}

			yOffset += mediaHeight + mediaGapAfter;
		} catch (error) {
			logger.warn({ error }, "Failed to load media image");
		}
	}

	if (tweet.quote && quoteHeight > 0) {
		if (!mainMedia) {
			yOffset += LAYOUT.AVATAR_GAP;
		}

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

		const quoteMedia = getFirstMedia(tweet.quote.media);
		if (quoteMedia && quoteMediaHeight > 0) {
			quoteY += LAYOUT.AVATAR_GAP;

			try {
				const quoteImageUrl =
					quoteMedia.type === "photo"
						? quoteMedia.url
						: quoteMedia.thumbnailUrl;
				const quoteImage = await loadImage(quoteImageUrl);

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

				if (quoteMediaIsVideo) {
					drawPlayButton({
						ctx,
						centerX: quoteX + quoteContentWidth / 2,
						centerY: quoteY + quoteMediaHeight / 2,
					});
				}
			} catch (error) {
				logger.warn({ error }, "Failed to load quote media image");
			}
		}

		yOffset += quoteHeight;
	}

	const hasNoMedia = !mainMedia;
	const hasNoQuote = !tweet.quote;
	if (hasNoMedia && hasNoQuote) {
		yOffset += LAYOUT.AVATAR_GAP;
	}

	ctx.fillStyle = colors.secondaryText;
	ctx.font = `${LAYOUT.FONT_SIZE_STATS}px ${fontFamily}`;

	const stats = [
		tweet.createdAt ? format(tweet.createdAt, "MMM d, yyyy") : null,
		`${formatNumber(tweet.replies)} replies`,
		`${formatNumber(tweet.retweets)} reposts`,
		`${formatNumber(tweet.likes)} likes`,
	].filter((s): s is string => s !== null);

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
		width: LAYOUT.WIDTH * scale,
		height: totalHeight * scale,
	};
}
