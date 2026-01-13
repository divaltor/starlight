import { type SKRSContext2D, createCanvas } from "@napi-rs/canvas";
import { format } from "date-fns";
import { logger } from "@/logger";
import {
	drawAuthorInfo,
	drawAvatarWithFallback,
	drawMediaBlock,
	drawTextLines,
	formatNumber,
	roundedRect,
	wrapText,
} from "./draw";
import { getFontFamily, registerFonts } from "./fonts";
import { LAYOUT } from "./layout";
import { type Theme, type ThemeColors, themes } from "./themes";

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
const DOTS_INDICATOR_HEIGHT = 32;
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

type TweetLayout = {
	totalHeight: number;
	contentWidth: number;
	textX: number;
	textWidth: number;

	mainTweet: {
		textLines: ReturnType<typeof wrapText>;
		textHeight: number;
		mediaHeight: number;
		isVideo: boolean;
	};

	quote: {
		textLines: ReturnType<typeof wrapText>;
		textHeight: number;
		mediaHeight: number;
		isVideo: boolean;
		height: number;
		contentWidth: number;
	} | null;

	replyChain: ReplyChainItem[];
	totalReplyChainHeight: number;
	hasMoreInChain: boolean;
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

function calculateTextHeight(
	lines: { isParagraphEnd: boolean }[],
	fontSize: number,
	lineHeight: number,
	paragraphGap: number
): number {
	const paragraphCount = lines.filter((line) => line.isParagraphEnd).length;
	return Math.floor(
		lines.length * fontSize * lineHeight + paragraphCount * paragraphGap
	);
}

function calculateMediaHeight(
	media: MediaItem | null,
	containerWidth: number
): { height: number; isVideo: boolean } {
	if (!media) {
		return { height: 0, isVideo: false };
	}
	const aspectRatio = media.width / media.height;
	const height = Math.floor(containerWidth / aspectRatio);
	const isVideo = media.type === "video" || media.type === "gif";
	return { height, isVideo };
}

function measureTweetLayout(tweet: TweetData, fontFamily: string): TweetLayout {
	const contentWidth = LAYOUT.WIDTH - LAYOUT.PADDING * 2;
	const textX = LAYOUT.PADDING + LAYOUT.AVATAR_SIZE + LAYOUT.AVATAR_GAP;
	const textWidth = contentWidth - LAYOUT.AVATAR_SIZE - LAYOUT.AVATAR_GAP;
	const replyToTextWidth = contentWidth - REPLY_AVATAR_SIZE - LAYOUT.AVATAR_GAP;

	const measureCanvas = createCanvas(LAYOUT.WIDTH, 100);
	const measureCtx = measureCanvas.getContext("2d");

	measureCtx.font = `${LAYOUT.FONT_SIZE_TEXT}px ${fontFamily}`;
	const mainTextLines = wrapText(measureCtx, tweet.text, textWidth);
	const mainTextHeight = calculateTextHeight(
		mainTextLines,
		LAYOUT.FONT_SIZE_TEXT,
		LAYOUT.LINE_HEIGHT,
		LAYOUT.PARAGRAPH_GAP
	);

	const mainMedia = getFirstMedia(tweet.media);
	const { height: mainMediaHeight, isVideo: mainMediaIsVideo } =
		calculateMediaHeight(mainMedia, contentWidth);

	let quoteLayout: TweetLayout["quote"] = null;
	const quoteContentWidth = contentWidth - QUOTE_PADDING * 2;

	if (tweet.quote) {
		measureCtx.font = `${QUOTE_FONT_SIZE_TEXT}px ${fontFamily}`;
		const quoteTextLines = wrapText(
			measureCtx,
			tweet.quote.text,
			quoteContentWidth - QUOTE_AVATAR_SIZE - LAYOUT.AVATAR_GAP
		);
		const quoteTextHeight = calculateTextHeight(
			quoteTextLines,
			QUOTE_FONT_SIZE_TEXT,
			LAYOUT.LINE_HEIGHT,
			LAYOUT.PARAGRAPH_GAP
		);

		const quoteMedia = getFirstMedia(tweet.quote.media);
		const { height: quoteMediaHeight, isVideo: quoteMediaIsVideo } =
			calculateMediaHeight(quoteMedia, quoteContentWidth);

		const quoteHeight = Math.floor(
			QUOTE_PADDING * 2 +
				Math.max(
					QUOTE_AVATAR_SIZE,
					QUOTE_FONT_SIZE_NAME + LAYOUT.TEXT_GAP + quoteTextHeight
				) +
				(quoteMediaHeight > 0 ? LAYOUT.AVATAR_GAP + quoteMediaHeight : 0)
		);

		quoteLayout = {
			textLines: quoteTextLines,
			textHeight: quoteTextHeight,
			mediaHeight: quoteMediaHeight,
			isVideo: quoteMediaIsVideo,
			height: quoteHeight,
			contentWidth: quoteContentWidth,
		};
	}

	const replyChainItems: ReplyChainItem[] = [];
	let totalReplyChainHeight = 0;

	if (tweet.replyChain && tweet.replyChain.length > 0) {
		if (tweet.hasMoreInChain) {
			totalReplyChainHeight += DOTS_INDICATOR_HEIGHT;
		}

		for (const chainTweet of tweet.replyChain) {
			measureCtx.font = `${REPLY_FONT_SIZE_TEXT}px ${fontFamily}`;
			const chainTextLines = wrapText(
				measureCtx,
				chainTweet.text,
				replyToTextWidth
			);
			const chainTextHeight = calculateTextHeight(
				chainTextLines,
				REPLY_FONT_SIZE_TEXT,
				LAYOUT.LINE_HEIGHT,
				LAYOUT.PARAGRAPH_GAP
			);

			const chainMedia = getFirstMedia(chainTweet.media);
			const { height: chainMediaHeight, isVideo: chainMediaIsVideo } =
				calculateMediaHeight(chainMedia, replyToTextWidth);

			const itemHeight = Math.floor(
				REPLY_AVATAR_SIZE +
					LAYOUT.AVATAR_GAP +
					Math.max(
						0,
						chainTextHeight -
							REPLY_AVATAR_SIZE +
							REPLY_FONT_SIZE_NAME +
							LAYOUT.TEXT_GAP
					) +
					(chainMediaHeight > 0
						? LAYOUT.AVATAR_GAP + chainMediaHeight + LAYOUT.MEDIA_GAP
						: LAYOUT.AVATAR_GAP)
			);

			replyChainItems.push({
				tweet: chainTweet,
				textLines: chainTextLines,
				height: itemHeight,
				mediaHeight: chainMediaHeight,
				isVideo: chainMediaIsVideo,
			});
			totalReplyChainHeight += itemHeight;
		}
	}

	const headerHeight = LAYOUT.AVATAR_SIZE;
	const statsHeight = LAYOUT.STATS_HEIGHT;
	const mediaGapAfter = LAYOUT.MEDIA_GAP_BOTTOM;

	const totalHeight =
		LAYOUT.PADDING +
		totalReplyChainHeight +
		headerHeight +
		LAYOUT.AVATAR_GAP +
		mainTextHeight +
		(mainMediaHeight > 0
			? LAYOUT.AVATAR_GAP + mainMediaHeight + mediaGapAfter
			: 0) +
		(quoteLayout
			? (mainMediaHeight > 0 ? 0 : LAYOUT.AVATAR_GAP) + quoteLayout.height
			: 0) +
		LAYOUT.AVATAR_GAP +
		statsHeight +
		LAYOUT.PADDING;

	return {
		totalHeight,
		contentWidth,
		textX,
		textWidth,
		mainTweet: {
			textLines: mainTextLines,
			textHeight: mainTextHeight,
			mediaHeight: mainMediaHeight,
			isVideo: mainMediaIsVideo,
		},
		quote: quoteLayout,
		replyChain: replyChainItems,
		totalReplyChainHeight,
		hasMoreInChain: tweet.hasMoreInChain ?? false,
	};
}

type DrawReplyChainParams = {
	ctx: SKRSContext2D;
	items: ReplyChainItem[];
	hasMoreInChain: boolean;
	startY: number;
	colors: ThemeColors;
	fontFamily: string;
	replyToTextX: number;
	replyToTextWidth: number;
};

async function drawReplyChain(params: DrawReplyChainParams): Promise<number> {
	const {
		ctx,
		items,
		hasMoreInChain,
		startY,
		colors,
		fontFamily,
		replyToTextX,
		replyToTextWidth,
	} = params;

	let yOffset = startY;
	const replyAvatarCenterX = LAYOUT.PADDING + REPLY_AVATAR_SIZE / 2;

	if (hasMoreInChain) {
		ctx.fillStyle = colors.border;
		for (let i = 0; i < 3; i++) {
			ctx.beginPath();
			ctx.arc(
				replyAvatarCenterX,
				yOffset + 12 + (i - 1) * (DOT_SIZE + DOT_GAP),
				DOT_SIZE / 2,
				0,
				Math.PI * 2
			);
			ctx.fill();
		}
		yOffset += DOTS_INDICATOR_HEIGHT;
	}

	for (const item of items) {
		await drawAvatarWithFallback({
			ctx,
			url: item.tweet.authorAvatarUrl,
			x: LAYOUT.PADDING,
			y: yOffset,
			size: REPLY_AVATAR_SIZE,
			fallbackColor: colors.secondaryText,
		});

		drawAuthorInfo({
			ctx,
			name: item.tweet.authorName,
			username: item.tweet.authorUsername,
			x: replyToTextX,
			y: yOffset,
			fontSize: REPLY_FONT_SIZE_NAME,
			fontFamily,
			textColor: colors.text,
			secondaryColor: colors.secondaryText,
			inline: true,
		});

		const replyTextY = drawTextLines({
			ctx,
			lines: item.textLines,
			x: replyToTextX,
			startY: yOffset + REPLY_FONT_SIZE_NAME + LAYOUT.TEXT_GAP,
			fontSize: REPLY_FONT_SIZE_TEXT,
			lineHeight: LAYOUT.LINE_HEIGHT,
			paragraphGap: LAYOUT.PARAGRAPH_GAP,
			color: colors.text,
			fontFamily,
		});

		const chainMedia = getFirstMedia(item.tweet.media);
		if (chainMedia && item.mediaHeight > 0) {
			const chainImageUrl =
				chainMedia.type === "photo" ? chainMedia.url : chainMedia.thumbnailUrl;
			await drawMediaBlock({
				ctx,
				imageUrl: chainImageUrl,
				x: replyToTextX,
				y: replyTextY + LAYOUT.AVATAR_GAP,
				width: replyToTextWidth,
				height: item.mediaHeight,
				isVideo: item.isVideo,
				backgroundColor: colors.background,
				borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
			});
		}

		const lineMargin = 4;
		const lineStartY = yOffset + REPLY_AVATAR_SIZE + lineMargin;
		const bottomGap =
			item.mediaHeight > 0 ? LAYOUT.MEDIA_GAP : LAYOUT.AVATAR_GAP;
		const lineEndY = yOffset + item.height - bottomGap / 2;

		ctx.strokeStyle = colors.border;
		ctx.lineWidth = REPLY_LINE_WIDTH;
		ctx.beginPath();
		ctx.moveTo(replyAvatarCenterX, lineStartY);
		ctx.lineTo(replyAvatarCenterX, lineEndY);
		ctx.stroke();

		yOffset += item.height;
	}

	return yOffset;
}

type DrawQuoteTweetParams = {
	ctx: SKRSContext2D;
	quote: TweetData;
	quoteLayout: NonNullable<TweetLayout["quote"]>;
	x: number;
	y: number;
	contentWidth: number;
	colors: ThemeColors;
	fontFamily: string;
};

async function drawQuoteTweet(params: DrawQuoteTweetParams): Promise<void> {
	const { ctx, quote, quoteLayout, x, y, contentWidth, colors, fontFamily } =
		params;

	ctx.strokeStyle = colors.border;
	ctx.lineWidth = QUOTE_BORDER_WIDTH;
	roundedRect({
		ctx,
		x,
		y,
		width: contentWidth,
		height: quoteLayout.height,
		radius: LAYOUT.MEDIA_BORDER_RADIUS,
	});
	ctx.stroke();

	const quoteX = x + QUOTE_PADDING;
	const quoteTextX = quoteX + QUOTE_AVATAR_SIZE + LAYOUT.AVATAR_GAP;
	let quoteY = y + QUOTE_PADDING;

	await drawAvatarWithFallback({
		ctx,
		url: quote.authorAvatarUrl,
		x: quoteX,
		y: quoteY,
		size: QUOTE_AVATAR_SIZE,
		fallbackColor: colors.secondaryText,
	});

	drawAuthorInfo({
		ctx,
		name: quote.authorName,
		username: quote.authorUsername,
		x: quoteTextX,
		y: quoteY,
		fontSize: QUOTE_FONT_SIZE_NAME,
		fontFamily,
		textColor: colors.text,
		secondaryColor: colors.secondaryText,
		inline: true,
	});

	quoteY = drawTextLines({
		ctx,
		lines: quoteLayout.textLines,
		x: quoteTextX,
		startY: quoteY + QUOTE_FONT_SIZE_NAME + LAYOUT.TEXT_GAP,
		fontSize: QUOTE_FONT_SIZE_TEXT,
		lineHeight: LAYOUT.LINE_HEIGHT,
		paragraphGap: LAYOUT.PARAGRAPH_GAP,
		color: colors.text,
		fontFamily,
	});

	const quoteMedia = getFirstMedia(quote.media);
	if (quoteMedia && quoteLayout.mediaHeight > 0) {
		const quoteImageUrl =
			quoteMedia.type === "photo" ? quoteMedia.url : quoteMedia.thumbnailUrl;
		await drawMediaBlock({
			ctx,
			imageUrl: quoteImageUrl,
			x: quoteX,
			y: quoteY + LAYOUT.AVATAR_GAP,
			width: quoteLayout.contentWidth,
			height: quoteLayout.mediaHeight,
			isVideo: quoteLayout.isVideo,
			backgroundColor: colors.background,
			borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
		});
	}
}

type DrawCardBackgroundParams = {
	ctx: SKRSContext2D;
	totalHeight: number;
	colors: ThemeColors;
};

function drawCardBackground(params: DrawCardBackgroundParams): void {
	const { ctx, totalHeight, colors } = params;
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
}

type DrawStatsParams = {
	ctx: SKRSContext2D;
	tweet: TweetData;
	y: number;
	colors: ThemeColors;
	fontFamily: string;
};

function drawStats(params: DrawStatsParams): void {
	const { ctx, tweet, y, colors, fontFamily } = params;

	ctx.fillStyle = colors.secondaryText;
	ctx.font = `${LAYOUT.FONT_SIZE_STATS}px ${fontFamily}`;

	const stats = [
		tweet.createdAt ? format(tweet.createdAt, "MMM d, yyyy") : null,
		`${formatNumber(tweet.replies)} replies`,
		`${formatNumber(tweet.retweets)} reposts`,
		`${formatNumber(tweet.likes)} likes`,
	].filter((s): s is string => s !== null);

	ctx.fillText(stats.join("  ·  "), LAYOUT.PADDING, y + LAYOUT.FONT_SIZE_STATS);
}

export async function renderTweetImage(
	tweet: TweetData,
	theme: Theme
): Promise<RenderResult> {
	registerFonts();

	const colors = themes[theme];
	const fontFamily = getFontFamily();

	const layout = measureTweetLayout(tweet, fontFamily);

	const mainMedia = getFirstMedia(tweet.media);
	const replyToTextX = LAYOUT.PADDING + REPLY_AVATAR_SIZE + LAYOUT.AVATAR_GAP;
	const replyToTextWidth =
		layout.contentWidth - REPLY_AVATAR_SIZE - LAYOUT.AVATAR_GAP;

	const headerHeight = LAYOUT.AVATAR_SIZE;
	const mediaGapAfter = LAYOUT.MEDIA_GAP_BOTTOM;

	const scale = LAYOUT.SCALE_FACTOR;
	const canvas = createCanvas(LAYOUT.WIDTH * scale, layout.totalHeight * scale);
	const ctx = canvas.getContext("2d");
	ctx.scale(scale, scale);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	drawCardBackground({ ctx, totalHeight: layout.totalHeight, colors });

	let yOffset: number = LAYOUT.PADDING;

	if (layout.replyChain.length > 0) {
		yOffset = await drawReplyChain({
			ctx,
			items: layout.replyChain,
			hasMoreInChain: layout.hasMoreInChain,
			startY: yOffset,
			colors,
			fontFamily,
			replyToTextX,
			replyToTextWidth,
		});
	}

	await drawAvatarWithFallback({
		ctx,
		url: tweet.authorAvatarUrl,
		x: LAYOUT.PADDING,
		y: yOffset,
		size: LAYOUT.AVATAR_SIZE,
		fallbackColor: colors.secondaryText,
	});

	ctx.fillStyle = colors.text;
	ctx.font = `bold ${LAYOUT.FONT_SIZE_NAME}px ${fontFamily}`;
	ctx.fillText(tweet.authorName, layout.textX, yOffset + LAYOUT.NAME_OFFSET_Y);

	ctx.fillStyle = colors.secondaryText;
	ctx.font = `${LAYOUT.FONT_SIZE_USERNAME}px ${fontFamily}`;
	ctx.fillText(
		`@${tweet.authorUsername}`,
		layout.textX,
		yOffset + LAYOUT.USERNAME_OFFSET_Y
	);

	yOffset += headerHeight + LAYOUT.AVATAR_GAP;

	yOffset = drawTextLines({
		ctx,
		lines: layout.mainTweet.textLines,
		x: LAYOUT.PADDING,
		startY: yOffset,
		fontSize: LAYOUT.FONT_SIZE_TEXT,
		lineHeight: LAYOUT.LINE_HEIGHT,
		paragraphGap: LAYOUT.PARAGRAPH_GAP,
		color: colors.text,
		fontFamily,
	});

	if (mainMedia && layout.mainTweet.mediaHeight > 0) {
		yOffset += LAYOUT.AVATAR_GAP;

		const imageUrl =
			mainMedia.type === "photo" ? mainMedia.url : mainMedia.thumbnailUrl;
		await drawMediaBlock({
			ctx,
			imageUrl,
			x: LAYOUT.PADDING,
			y: yOffset,
			width: layout.contentWidth,
			height: layout.mainTweet.mediaHeight,
			isVideo: layout.mainTweet.isVideo,
			backgroundColor: colors.background,
			borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
		});

		yOffset += layout.mainTweet.mediaHeight + mediaGapAfter;
	}

	if (tweet.quote && layout.quote) {
		if (!mainMedia) {
			yOffset += LAYOUT.AVATAR_GAP;
		}

		await drawQuoteTweet({
			ctx,
			quote: tweet.quote,
			quoteLayout: layout.quote,
			x: LAYOUT.PADDING,
			y: yOffset,
			contentWidth: layout.contentWidth,
			colors,
			fontFamily,
		});

		yOffset += layout.quote.height;
	}

	yOffset += LAYOUT.AVATAR_GAP;

	drawStats({ ctx, tweet, y: yOffset, colors, fontFamily });

	const buffer = canvas.toBuffer("image/jpeg", 100);

	logger.debug(
		{ width: LAYOUT.WIDTH, height: layout.totalHeight, size: buffer.length },
		"Rendered tweet image"
	);

	return {
		buffer,
		width: LAYOUT.WIDTH * scale,
		height: layout.totalHeight * scale,
	};
}
