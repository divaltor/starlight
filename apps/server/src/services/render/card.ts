import { format } from "date-fns";
import type { Node } from "takumi-js";
import { container, image, text } from "takumi-js/helpers";
import { LAYOUT } from "./layout";
import type { ThemeColors } from "./themes";
import type { ArticleData, TweetData } from ".";

// Takumi derives its style types from react's CSSProperties, which this
// package deliberately does not depend on; a permissive local shape covers
// every property the card uses.
type Style = Record<string, string | number | undefined>;

// Taffy's block-flow mode collapses stacked non-text children during layout,
// so every wrapper must be an explicit flex column (rows override direction).
function box(params: { children?: Node[]; style?: Style }): Node {
	return container({
		children: params.children,
		style: { display: "flex", flexDirection: "column", ...params.style },
	});
}

const QUOTE_AVATAR_SIZE = 24;
const QUOTE_FONT_SIZE_NAME = 13;
const QUOTE_FONT_SIZE_TEXT = 14;
const QUOTE_PADDING = 12;

const REPLY_FONT_SIZE_NAME = 13;
const REPLY_FONT_SIZE_TEXT = 14;
const REPLY_LINE_WIDTH = 2;

const ARTICLE_PADDING = 12;
const ARTICLE_TITLE_FONT_SIZE = 15;
const ARTICLE_PREVIEW_FONT_SIZE = 14;

const DOTS_INDICATOR_HEIGHT = 32;
const DOT_SIZE = 4;
const DOT_GAP = 6;
const PLAY_BUTTON_HEIGHT = 48;
const PLAY_BUTTON_WIDTH = 38;

// Vertical rhythm carried over from the canvas renderer: blocks after the body
// text keep an 8px gap before whatever follows, and a quote only gets its own
// 12px gap when no media/article block already separates it from the text.
const BLOCK_GAP_BOTTOM = LAYOUT.MEDIA_GAP_BOTTOM;
const CARD_WIDTH_INNER = LAYOUT.WIDTH - LAYOUT.PADDING * 2;
const CHAIN_CONTENT_WIDTH = CARD_WIDTH_INNER - LAYOUT.AVATAR_SIZE - LAYOUT.AVATAR_GAP;

export interface BuildCardParams {
	colors: ThemeColors;
	failedUrls: Set<string>;
	tweet: TweetData;
}

// Percent and aspect-ratio sizing resolves unreliably during measure(), so every
// box carries explicit pixel geometry — the same numbers the canvas renderer used.
export function buildTweetCard(params: BuildCardParams): Node {
	const chain = params.tweet.replyChain ?? [];
	const chainNodes = chain.map((chainTweet) =>
		replyChainItem(params.colors, params.failedUrls, chainTweet),
	);
	const dots =
		chain.length > 0 && params.tweet.hasMoreInChain ? [dotsIndicator(params.colors)] : [];

	const tail: Node[] = [
		headerRow(params.colors, params.failedUrls, params.tweet),
		box({
			children: buildTextParagraphs(params.tweet.text, {
				color: params.colors.text,
				fontSize: LAYOUT.FONT_SIZE_TEXT,
				lineHeight: LAYOUT.LINE_HEIGHT,
				width: CARD_WIDTH_INNER,
			}),
			style: { marginTop: LAYOUT.AVATAR_GAP },
		}),
		...tweetExtrasNodes(params.colors, CARD_WIDTH_INNER, params.failedUrls, params.tweet),
		...(params.tweet.quote
			? [quoteBox(params.colors, params.failedUrls, CARD_WIDTH_INNER, params.tweet.quote)]
			: []),
		statsRow(params.colors, CARD_WIDTH_INNER, params.tweet),
	];

	return box({
		children: [...dots, ...chainNodes, ...tail],
		style: {
			backgroundColor: params.colors.cardBackground,
			borderColor: params.colors.border,
			borderRadius: LAYOUT.CARD_BORDER_RADIUS,
			borderStyle: "solid",
			borderWidth: 1,
			padding: LAYOUT.PADDING,
			width: LAYOUT.WIDTH,
		},
	});
}

function statsRow(colors: ThemeColors, width: number, tweet: TweetData): Node {
	return box({
		children: [
			text(statsLine(tweet), { color: colors.secondaryText, fontSize: LAYOUT.FONT_SIZE_STATS }),
		],
		style: { marginTop: LAYOUT.AVATAR_GAP, width },
	});
}

export function collectTweetImageUrls(tweet: TweetData): Set<string> {
	const urls = new Set<string>([tweet.authorAvatarUrl]);

	const media = getFirstMedia(tweet.media);
	if (media) {
		urls.add(getMediaImageUrl(media));
	}

	if (tweet.article?.coverMedia) {
		urls.add(tweet.article.coverMedia.url);
	}

	if (tweet.quote) {
		for (const url of collectTweetImageUrls(tweet.quote)) {
			urls.add(url);
		}
	}

	for (const chainTweet of tweet.replyChain ?? []) {
		for (const url of collectTweetImageUrls(chainTweet)) {
			urls.add(url);
		}
	}

	return urls;
}

export function collectRemoteImageSrcs(node: Node, into = new Set<string>()): Set<string> {
	if (node.type === "image") {
		if (typeof node.src === "string" && node.src.startsWith("http")) {
			into.add(node.src);
		}
	} else if (node.type === "container") {
		for (const child of node.children ?? []) {
			collectRemoteImageSrcs(child, into);
		}
	}
	return into;
}

/** Drops remote-image nodes whose fetch failed (emoji glyphs), so the render never hits the network. */
export function stripUnavailableImages(node: Node, fetchedBytes: Map<string, Uint8Array>): void {
	if (node.type !== "container") {
		return;
	}
	node.children = (node.children ?? []).filter((child) => {
		if (child.type === "image" && typeof child.src === "string" && child.src.startsWith("http")) {
			return fetchedBytes.has(child.src);
		}
		stripUnavailableImages(child, fetchedBytes);
		return true;
	});
}

// Mirrors the old wrapText preprocessing: leading mentions stripped, a blank
// line forced before a trailing hashtag block, "\n\n" starts a spaced paragraph,
// single "\n" a plain line break.
export function buildTextParagraphs(rawText: string, style: Style): Node[] {
	const cleaned = stripLeadingMentions(rawText).replace(HASHTAG_BLOCK_RE, "\n\n$<hashtagBlock>");
	const paragraphs = cleaned.split(/\n\n+/u);

	return paragraphs.flatMap((paragraph, pIndex) => {
		const lines = paragraph
			.split(/\n/u)
			.map((line) => line.trim())
			.filter((line) => line !== "");

		if (lines.length === 0) {
			return [];
		}

		const isLastParagraph = pIndex === paragraphs.length - 1;
		return [
			// One text node per paragraph: sibling text nodes collapse in layout.
			box({
				children: [text(lines.join("\n"), { whiteSpace: "pre-line" })],
				style: {
					// Breaks over-long tokens (URLs) instead of overflowing the card,
					// matching the old breakLongWord behavior.
					...style,
					marginBottom: isLastParagraph ? 0 : LAYOUT.PARAGRAPH_GAP,
					overflowWrap: "anywhere",
				},
			}),
		];
	});
}

function headerRow(colors: ThemeColors, failedUrls: Set<string>, tweet: TweetData): Node {
	const language = getTranslationLanguage(tweet);
	return box({
		children: [
			avatarOrFallback(tweet.authorAvatarUrl, LAYOUT.AVATAR_SIZE, colors, failedUrls),
			box({
				children: [
					box({
						children: [
							text(tweet.authorName, {
								color: colors.text,
								fontSize: LAYOUT.FONT_SIZE_NAME,
								fontWeight: 700,
							}),
						],
						style: { width: CHAIN_CONTENT_WIDTH },
					}),
					box({
						children: [
							text(`@${tweet.authorUsername}`, {
								color: colors.secondaryText,
								fontSize: LAYOUT.FONT_SIZE_USERNAME,
							}),
							...(language ? translationBadge(language, colors, LAYOUT.FONT_SIZE_USERNAME) : []),
						],
						style: {
							display: "flex",
							flexDirection: "row",
							flexWrap: "wrap",
							marginTop: 2,
							width: CHAIN_CONTENT_WIDTH,
						},
					}),
				],
			}),
		],
		style: { display: "flex", flexDirection: "row", gap: LAYOUT.AVATAR_GAP },
	});
}

function nameRowNodes(colors: ThemeColors, fontSize: number, tweet: TweetData): Node[] {
	const language = getTranslationLanguage(tweet);
	return [
		text(tweet.authorName, { color: colors.text, fontSize, fontWeight: 700 }),
		text(` @${tweet.authorUsername}`, { color: colors.secondaryText, fontSize }),
		...(language ? translationBadge(language, colors, fontSize) : []),
	];
}

function translationBadge(language: string, colors: ThemeColors, fontSize: number): Node[] {
	return [
		text("·", { color: colors.secondaryText, fontSize, marginInline: 3 }),
		text(`Translated from ${language}`, { color: colors.text, fontSize }),
	];
}

function replyChainItem(colors: ThemeColors, failedUrls: Set<string>, tweet: TweetData): Node {
	return box({
		style: {
			marginBottom: LAYOUT.AVATAR_GAP,
			paddingLeft: LAYOUT.AVATAR_SIZE + LAYOUT.AVATAR_GAP,
			position: "relative",
		},
		children: [
			positioned(avatarOrFallback(tweet.authorAvatarUrl, LAYOUT.AVATAR_SIZE, colors, failedUrls), {
				left: 0,
				top: 0,
			}),
			box({
				style: {
					backgroundColor: colors.border,
					bottom: LAYOUT.AVATAR_GAP / 2,
					left: (LAYOUT.AVATAR_SIZE - REPLY_LINE_WIDTH) / 2,
					position: "absolute",
					top: LAYOUT.AVATAR_SIZE + 4,
					width: REPLY_LINE_WIDTH,
				},
			}),
			box({
				children: [
					box({
						children: nameRowNodes(colors, REPLY_FONT_SIZE_NAME, tweet),
						style: {
							alignItems: "baseline",
							display: "flex",
							flexDirection: "row",
							flexWrap: "wrap",
							width: CHAIN_CONTENT_WIDTH,
						},
					}),
					box({
						children: buildTextParagraphs(tweet.text, {
							color: colors.text,
							fontSize: REPLY_FONT_SIZE_TEXT,
							lineHeight: LAYOUT.LINE_HEIGHT,
							width: CHAIN_CONTENT_WIDTH,
						}),
						style: { marginTop: LAYOUT.TEXT_GAP },
					}),
					...tweetExtrasNodes(colors, CHAIN_CONTENT_WIDTH, failedUrls, tweet),
					...(tweet.quote ? [quoteBox(colors, failedUrls, CHAIN_CONTENT_WIDTH, tweet.quote)] : []),
				],
				style: { width: CHAIN_CONTENT_WIDTH },
			}),
		],
	});
}

function dotsIndicator(colors: ThemeColors): Node {
	return box({
		children: [
			box({
				children: [0, 1, 2].map(() =>
					box({
						style: {
							backgroundColor: colors.border,
							borderRadius: DOT_SIZE,
							height: DOT_SIZE,
							width: DOT_SIZE,
						},
					}),
				),
				style: {
					display: "flex",
					flexDirection: "column",
					gap: DOT_GAP,
					left: (LAYOUT.AVATAR_SIZE - DOT_SIZE) / 2,
					position: "absolute",
					top: (DOTS_INDICATOR_HEIGHT - (DOT_SIZE * 3 + DOT_GAP * 2)) / 2,
				},
			}),
		],
		style: { height: DOTS_INDICATOR_HEIGHT, position: "relative" },
	});
}

// Media and article blocks shared by the main tweet, quotes, and reply items.
function tweetExtrasNodes(
	colors: ThemeColors,
	contentWidth: number,
	failedUrls: Set<string>,
	tweet: TweetData,
): Node[] {
	const media = getFirstMedia(tweet.media);
	return [
		...(media ? [mediaBlock(colors, contentWidth, media, failedUrls)] : []),
		...(tweet.article ? [articleBlock(colors, contentWidth, tweet.article)] : []),
	];
}

function quoteBox(
	colors: ThemeColors,
	failedUrls: Set<string>,
	outerWidth: number,
	quote: TweetData,
): Node {
	const innerWidth = outerWidth - QUOTE_PADDING * 2;
	const children: Node[] = [
		box({
			children: [
				avatarOrFallback(quote.authorAvatarUrl, QUOTE_AVATAR_SIZE, colors, failedUrls),
				box({
					children: nameRowNodes(colors, QUOTE_FONT_SIZE_NAME, quote),
					style: {
						alignItems: "baseline",
						display: "flex",
						flexDirection: "row",
						flexWrap: "wrap",
						flexGrow: 1,
					},
				}),
			],
			style: {
				alignItems: "center",
				display: "flex",
				flexDirection: "row",
				gap: LAYOUT.AVATAR_GAP,
				width: innerWidth,
			},
		}),
		box({
			children: buildTextParagraphs(quote.text, {
				color: colors.text,
				fontSize: QUOTE_FONT_SIZE_TEXT,
				lineHeight: LAYOUT.LINE_HEIGHT,
				width: innerWidth,
			}),
			style: { marginTop: LAYOUT.TEXT_GAP },
		}),
	];
	children.push(...tweetExtrasNodes(colors, innerWidth, failedUrls, quote));

	return box({
		style: {
			borderColor: colors.border,
			borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
			borderStyle: "solid",
			borderWidth: 1,
			marginTop: LAYOUT.AVATAR_GAP,
			padding: QUOTE_PADDING,
			width: outerWidth,
		},
		children,
	});
}

function articleBlock(colors: ThemeColors, contentWidth: number, article: ArticleData): Node {
	const innerWidth = contentWidth - ARTICLE_PADDING * 2;
	const cover = article.coverMedia;
	const children: Node[] = [];

	if (cover) {
		children.push(
			image({
				src: cover.url,
				style: {
					height: scaledHeight(cover.width, cover.height, contentWidth),
					objectFit: "cover",
					width: contentWidth,
				},
			}),
		);
	}

	children.push(
		box({
			children: [
				box({
					children: buildTextParagraphs(article.title, {
						color: colors.text,
						fontSize: ARTICLE_TITLE_FONT_SIZE,
						fontWeight: 700,
						lineHeight: LAYOUT.LINE_HEIGHT,
						width: innerWidth,
					}),
				}),
				box({
					children: buildTextParagraphs(article.previewText, {
						color: colors.secondaryText,
						fontSize: ARTICLE_PREVIEW_FONT_SIZE,
						lineHeight: LAYOUT.LINE_HEIGHT,
						width: innerWidth,
					}),
					style: { marginTop: LAYOUT.TEXT_GAP },
				}),
			],
			style: { padding: ARTICLE_PADDING },
		}),
	);

	return box({
		style: {
			borderColor: colors.border,
			borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
			borderStyle: "solid",
			borderWidth: 1,
			marginBottom: BLOCK_GAP_BOTTOM,
			marginTop: LAYOUT.AVATAR_GAP,
			overflow: "hidden",
			width: contentWidth,
		},
		children,
	});
}

function mediaBlock(
	colors: ThemeColors,
	contentWidth: number,
	media: MediaItem,
	failedUrls: Set<string>,
): Node {
	const unavailable = failedUrls.has(getMediaImageUrl(media));
	const height = scaledHeight(media.width, media.height, contentWidth);
	const isVideo = media.type === "video" || media.type === "gif";

	return box({
		style: {
			backgroundColor: colors.background,
			borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
			height,
			marginBottom: BLOCK_GAP_BOTTOM,
			marginTop: LAYOUT.AVATAR_GAP,
			overflow: "hidden",
			position: "relative",
			width: contentWidth,
		},
		children: [
			...(unavailable
				? []
				: [
						image({
							src: getMediaImageUrl(media),
							style: { height, objectFit: "cover", width: contentWidth },
						}),
					]),
			...(isVideo && !unavailable ? [playButtonOverlay(contentWidth, height)] : []),
		],
	});
}

function playButtonOverlay(boxWidth: number, boxHeight: number): Node {
	return box({
		children: [
			box({
				style: {
					backgroundColor: "rgba(255, 255, 255, 0.85)",
					clipPath: "polygon(0% 0%, 100% 50%, 0% 100%)",
					height: PLAY_BUTTON_HEIGHT,
					marginLeft: 4,
					width: PLAY_BUTTON_WIDTH,
				},
			}),
		],
		style: {
			alignItems: "center",
			display: "flex",
			height: boxHeight,
			justifyContent: "center",
			left: 0,
			position: "absolute",
			top: 0,
			width: boxWidth,
		},
	});
}

function avatarNode(url: string, size: number): Node {
	return image({
		src: url,
		style: { borderRadius: size / 2, height: size, width: size },
	});
}

function avatarFallback(colors: ThemeColors, size: number): Node {
	return box({
		style: {
			backgroundColor: colors.secondaryText,
			borderRadius: size / 2,
			height: size,
			width: size,
		},
	});
}

function avatarOrFallback(
	url: string,
	size: number,
	colors: ThemeColors,
	failedUrls?: Set<string>,
): Node {
	if (failedUrls?.has(url)) {
		return avatarFallback(colors, size);
	}
	return avatarNode(url, size);
}

function positioned(node: Node, inset: { left: number; top: number }): Node {
	if (node.type !== "text") {
		node.style = { ...node.style, ...inset };
	}
	return node;
}

type MediaItem =
	| {
			formats: { jpeg: string; webp: string };
			height: number;
			type: "mosaic_photo";
			url: string;
			width: number;
	  }
	| { type: "photo"; url: string; width: number; height: number }
	| {
			type: "video" | "gif";
			thumbnailUrl: string;
			width: number;
			height: number;
	  };

function scaledHeight(sourceWidth: number, sourceHeight: number, boxWidth: number): number {
	return Math.round((sourceHeight / sourceWidth) * boxWidth);
}

function getFirstMedia(media: TweetData["media"]): MediaItem | null {
	if (!media) {
		return null;
	}

	if (media.mosaic) {
		return { type: "mosaic_photo", ...media.mosaic };
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

function getMediaImageUrl(media: MediaItem): string {
	if (media.type === "mosaic_photo") {
		return media.formats.jpeg;
	}

	if (media.type === "photo") {
		return media.url;
	}

	return media.thumbnailUrl;
}

function statsLine(tweet: TweetData): string {
	return [
		tweet.createdAt ? format(tweet.createdAt, "MMM d, yyyy") : null,
		`${formatNumber(tweet.replies)} replies`,
		`${formatNumber(tweet.retweets)} reposts`,
		`${formatNumber(tweet.likes)} likes`,
	]
		.filter((part): part is string => part !== null)
		.join("  ·  ");
}

const ONE_MILLION = 1_000_000;
const ONE_THOUSAND = 1000;

function formatNumber(num: number | null | undefined): string {
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

const languageDisplayNames = new Intl.DisplayNames(["en"], { type: "language" });

function getTranslationLanguage(tweet: Pick<TweetData, "translation">): string | null {
	const sourceLanguage = tweet.translation?.sourceLanguage;
	if (!sourceLanguage) {
		return null;
	}

	try {
		return languageDisplayNames.of(sourceLanguage.replace("_", "-")) ?? sourceLanguage;
	} catch {
		return sourceLanguage;
	}
}

function stripLeadingMentions(value: string): string {
	return value.replace(/^(?<mention>@\w+\s*)+/u, "").trimStart();
}

const HASHTAG_BLOCK_RE = /\n(?<hashtagBlock>#\S+(?:\s+#\S+)*\s*)$/u;
