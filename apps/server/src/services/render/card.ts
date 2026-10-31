import { format } from "date-fns";
import type { Node } from "takumi-js";
import { container, image, text } from "takumi-js/helpers";
import { LAYOUT } from "@/services/render/layout";
import type { ThemeColors } from "@/services/render/themes";
import type { ArticleData, LinkCardData, TweetData } from "@/services/render";

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
const ARTICLE_PREVIEW_MAX_LINES = 3;

const LINK_CARD_TITLE_INSET = 12;
const LINK_CARD_TITLE_FONT_SIZE = 14;
const LINK_CARD_TITLE_MAX_LINES = 2;

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

// X-style short timestamp: time before date, year only when it differs from the current one.
export function formatShortDate(createdAt: Date): string {
  return format(
    createdAt,
    createdAt.getFullYear() === new Date().getFullYear()
      ? "h:mm\u00A0a · MMM\u00A0d"
      : "h:mm\u00A0a · MMM\u00A0d, yyyy",
  );
}

export function formatTweetTimestamp(createdAt: Date): string {
  return format(createdAt, "h:mm\u00A0a · MMM\u00A0d, yyyy");
}

export interface BuildCardParams {
  colors: ThemeColors;
  failedUrls: Set<string>;
  tweet: TweetData;
}

// Percent and aspect-ratio sizing resolves unreliably during measure(), so every
// box carries explicit pixel geometry — the same numbers the canvas renderer used.
export function buildTweetCard(params: BuildCardParams): Node {
  const chain = params.tweet.replyChain ?? [];
  const chainNodes = chain.map((chainTweet) => replyChainItem(params.colors, params.failedUrls, chainTweet));
  const dots = chain.length > 0 && params.tweet.hasMoreInChain === true ? [dotsIndicator(params.colors)] : [];

  const tail: Node[] = [
    headerRow(params.colors, params.failedUrls, params.tweet),
    box({
      children: buildTextParagraphs(
        params.tweet.text,
        {
          color: params.colors.text,
          fontSize: LAYOUT.FONT_SIZE_TEXT,
          lineHeight: LAYOUT.LINE_HEIGHT,
          width: CARD_WIDTH_INNER,
        },
        params.colors.accent,
      ),
      style: { marginTop: LAYOUT.AVATAR_GAP },
    }),
    ...tweetExtrasNodes(params.colors, CARD_WIDTH_INNER, params.failedUrls, params.tweet),
    ...(params.tweet.quote
      ? [quoteBox(params.colors, params.failedUrls, CARD_WIDTH_INNER, params.tweet.quote, hasTweetExtras(params.tweet))]
      : []),
    // Timestamp and engagement counters footer.
    box({
      children: [
        text(
          [
            params.tweet.createdAt ? formatTweetTimestamp(params.tweet.createdAt) : null,
            `${formatNumber(params.tweet.replies)}\u00A0replies`,
            `${formatNumber(params.tweet.retweets)}\u00A0reposts`,
            `${formatNumber(params.tweet.likes)}\u00A0likes`,
          ]
            .filter((part): part is string => part !== null)
            .join("  ·  "),
          { color: params.colors.secondaryText, fontSize: LAYOUT.FONT_SIZE_STATS },
        ),
      ],
      style: { marginTop: LAYOUT.AVATAR_GAP, width: CARD_WIDTH_INNER },
    }),
  ];

  const card = box({
    children: [...dots, ...chainNodes, ...tail],
    style: {
      backgroundColor: params.colors.cardBackground,
      borderColor: params.colors.border,
      borderStyle: "solid",
      borderWidth: 1,
      padding: LAYOUT.PADDING,
      // Inherited by every text block: avoids a lone word on the last line.
      textWrap: "pretty",
      width: LAYOUT.WIDTH,
    },
  });

  return box({
    children: [card],
    style: { backgroundColor: params.colors.background, width: LAYOUT.WIDTH },
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

  if (tweet.card?.image) {
    urls.add(tweet.card.image.url);
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

export type TextRunKind = "link" | "mention" | "hashtag" | "plain";

export interface TextRun {
  kind: TextRunKind;
  value: string;
}

const TOKEN_RE =
  /(?<token>https?:\/\/\S+|(?<![\p{L}\p{N}_.%+-])@\w{1,15}|(?<![\p{L}\p{N}_])#[\p{L}\p{N}_][\p{L}\p{N}_\p{M}]*)/gu;

// Sentence punctuation hugging a URL belongs to the sentence, not the address.
const TRAILING_URL_PUNCT_RE =
  /(?<![.,;:!?"'“”‘’«»‹›「」『』（）【】。、，！？；：…])[.,;:!?"'“”‘’«»‹›「」『』（）【】。、，！？；：…]+$/u;

export function splitTextRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;

  for (const match of line.matchAll(TOKEN_RE)) {
    const token = match.groups?.token ?? match[0];
    const index = match.index ?? 0;

    if (index > last) {
      runs.push({ kind: "plain", value: line.slice(last, index) });
    }

    if (token.startsWith("http")) {
      const { url, tail } = splitUrlTail(token);
      runs.push({ kind: "link", value: url });

      if (tail !== "") {
        runs.push({ kind: "plain", value: tail });
      }
    } else {
      runs.push({ kind: token.startsWith("@") ? "mention" : "hashtag", value: token });
    }

    last = index + token.length;
  }

  if (last < line.length) {
    runs.push({ kind: "plain", value: line.slice(last) });
  }

  // URL-tail peeling can leave adjacent plain runs ("peel" + "suffix").
  const merged: TextRun[] = [];

  for (const run of runs) {
    const prev = merged.at(-1);

    if (prev?.kind === "plain" && run.kind === "plain") {
      prev.value += run.value;
    } else {
      merged.push(run);
    }
  }

  return merged;
}

// Peels sentence punctuation off a URL tail, unwinding to the last balanced
// bracket: "(https://x/y))" keeps one ")" inside the link, the outer lands
// back in plain text.
const CLOSING_TO_OPENING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function splitUrlTail(token: string): { url: string; tail: string } {
  let url = token;
  let tail = "";

  for (;;) {
    const punct = TRAILING_URL_PUNCT_RE.exec(url)?.[0] ?? "";

    if (punct !== "") {
      tail = punct + tail;
      url = url.slice(0, -punct.length);
      continue;
    }

    const closer = /[)\]}]$/u.exec(url)?.[0];

    if (closer === undefined || closer === "") {
      return { url, tail };
    }

    const opener = CLOSING_TO_OPENING[closer] ?? "";

    if (url.split(closer).length <= url.split(opener).length) {
      return { url, tail };
    }

    tail = closer + tail;
    url = url.slice(0, -closer.length);
  }
}

// Mirrors the old wrapText preprocessing: leading mentions stripped, a blank
// line forced before a trailing hashtag block, "\n\n" starts a spaced paragraph,
// single "\n" a plain line break. Like X, links, mentions, and hashtags render
// in the theme accent color at regular weight: one block host per paragraph
// carries the runs as inline text, so wrapping flows like normal text.
export function buildTextParagraphs(rawText: string, style: Style, accent: string): Node[] {
  const cleaned = rawText
    // Strip leading "@mention " prefixes before paragraph processing.
    .replace(/^(?:@\w+\s*)+/u, "")
    .trimStart()
    .replace(HASHTAG_BLOCK_RE, "\n\n$<hashtagBlock>");

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
    const marginBottom = isLastParagraph ? 0 : LAYOUT.PARAGRAPH_GAP;
    // Breaks over-long tokens (URLs) instead of overflowing the card,
    // matching the old breakLongWord behavior. Clamping belongs to the block
    // that lays out the runs, not to the runs themselves.
    const { width, lineClamp, ...textStyle } = style;

    const runs = lines.flatMap((line, lIndex) => [
      ...(lIndex === 0 ? [] : [{ kind: "plain", value: "\n" } satisfies TextRun]),
      ...splitTextRuns(line),
    ]);

    return [
      box({
        children: [
          container({
            children: runs.map((run) => {
              const runStyle: Style = {
                display: "inline",
                whiteSpace: "pre-line",
                overflowWrap: "anywhere",
                ...textStyle,
              };

              if (run.kind !== "plain") {
                runStyle.color = accent;
                runStyle.fontWeight = 400;
              }

              return text(run.value, runStyle);
            }),
            style: { display: "block", lineClamp, width },
          }),
        ],
        style: { marginBottom, width },
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
              ...(language !== null && language !== ""
                ? translationBadge(language, colors, LAYOUT.FONT_SIZE_USERNAME)
                : []),
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

  // Like X, name, handle, and date stay on one line: the handle truncates
  // first, then the name, and the date never does.
  return [
    box({
      children: [
        box({
          children: [
            // Keeps its full width until it alone overflows the space before the date.
            text(tweet.authorName, {
              color: colors.text,
              fontSize,
              fontWeight: 700,
              ...TRUNCATE,
              flexShrink: 0,
              maxWidth: "100%",
            }),
            // Takumi trims leading spaces in text nodes, so separators need explicit margins.
            text(`@${tweet.authorUsername}`, { color: colors.secondaryText, fontSize, marginLeft: 4, ...TRUNCATE }),
          ],
          style: { alignItems: "baseline", flexDirection: "row", ...TRUNCATE },
        }),
        ...(tweet.createdAt
          ? [
              text(`· ${formatShortDate(tweet.createdAt)}`, {
                color: colors.secondaryText,
                flexShrink: 0,
                fontSize,
                marginLeft: 4,
                whiteSpace: "nowrap",
              }),
            ]
          : []),
      ],
      style: { alignItems: "baseline", flexDirection: "row", flexShrink: 1, minWidth: 0 },
    }),
    ...(language !== null && language !== "" ? translationBadge(language, colors, fontSize) : []),
  ];
}

const TRUNCATE: Style = {
  flexShrink: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function translationBadge(language: string, colors: ThemeColors, fontSize: number): Node[] {
  return [
    text("·", { color: colors.secondaryText, fontSize, marginInline: 3 }),
    text(`Translated from ${language}`, { color: colors.text, fontSize }),
  ];
}

function replyChainItem(colors: ThemeColors, failedUrls: Set<string>, tweet: TweetData): Node {
  const avatar = avatarOrFallback(tweet.authorAvatarUrl, LAYOUT.AVATAR_SIZE, colors, failedUrls);

  // Reply avatars must not take space in the flex column and push the chain down.
  if (avatar.type !== "text") {
    avatar.style = { ...avatar.style, left: 0, top: 0, position: "absolute" };
  }

  return box({
    style: {
      marginBottom: LAYOUT.AVATAR_GAP,
      minHeight: LAYOUT.AVATAR_SIZE + LAYOUT.AVATAR_GAP,
      paddingLeft: LAYOUT.AVATAR_SIZE + LAYOUT.AVATAR_GAP,
      position: "relative",
    },
    children: [
      avatar,
      box({
        style: {
          backgroundColor: colors.border,
          bottom: -LAYOUT.AVATAR_GAP / 2,
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
            children: buildTextParagraphs(
              tweet.text,
              {
                color: colors.text,
                fontSize: REPLY_FONT_SIZE_TEXT,
                lineHeight: LAYOUT.LINE_HEIGHT,
                width: CHAIN_CONTENT_WIDTH,
              },
              colors.accent,
            ),
            style: { marginTop: LAYOUT.TEXT_GAP },
          }),
          ...tweetExtrasNodes(colors, CHAIN_CONTENT_WIDTH, failedUrls, tweet),
          ...(tweet.quote
            ? [quoteBox(colors, failedUrls, CHAIN_CONTENT_WIDTH, tweet.quote, hasTweetExtras(tweet))]
            : []),
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
    ...(tweet.card ? [linkCardBlock(colors, contentWidth, tweet.card, failedUrls)] : []),
  ];
}

function hasTweetExtras(tweet: TweetData): boolean {
  return getFirstMedia(tweet.media) !== null || tweet.article != null || tweet.card != null;
}

// Keep quote text beside the avatar as in the canvas renderer. The preceding
// media/article already supplies its own bottom gap, so it must not get another one.
function quoteBox(
  colors: ThemeColors,
  failedUrls: Set<string>,
  outerWidth: number,
  quote: TweetData,
  hasPrecedingExtra: boolean,
): Node {
  const innerWidth = outerWidth - QUOTE_PADDING * 2;
  const textWidth = innerWidth - QUOTE_AVATAR_SIZE - LAYOUT.AVATAR_GAP;

  const children: Node[] = [
    box({
      children: [
        avatarOrFallback(quote.authorAvatarUrl, QUOTE_AVATAR_SIZE, colors, failedUrls),
        box({
          children: [
            box({
              children: nameRowNodes(colors, QUOTE_FONT_SIZE_NAME, quote),
              style: {
                alignItems: "baseline",
                display: "flex",
                flexDirection: "row",
                flexWrap: "wrap",
                width: textWidth,
              },
            }),
            box({
              children: buildTextParagraphs(
                quote.text,
                {
                  color: colors.text,
                  fontSize: QUOTE_FONT_SIZE_TEXT,
                  lineHeight: LAYOUT.LINE_HEIGHT,
                  width: textWidth,
                },
                colors.accent,
              ),
              style: { marginTop: LAYOUT.TEXT_GAP },
            }),
          ],
          style: { width: textWidth },
        }),
      ],
      style: {
        display: "flex",
        flexDirection: "row",
        gap: LAYOUT.AVATAR_GAP,
        width: innerWidth,
      },
    }),
  ];

  children.push(...tweetExtrasNodes(colors, innerWidth, failedUrls, quote));

  return box({
    style: {
      borderColor: colors.border,
      borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
      borderStyle: "solid",
      borderWidth: 1,
      marginTop: hasPrecedingExtra ? 0 : LAYOUT.AVATAR_GAP,
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
          children: buildTextParagraphs(
            article.title,
            {
              color: colors.text,
              fontSize: ARTICLE_TITLE_FONT_SIZE,
              fontWeight: 700,
              lineHeight: LAYOUT.LINE_HEIGHT,
              width: innerWidth,
            },
            colors.accent,
          ),
          style: { textWrap: "balance" },
        }),
        box({
          // One collapsed paragraph so the clamp bounds the whole preview, as X does.
          children: buildTextParagraphs(
            article.previewText.replaceAll(/\s+/gu, " "),
            {
              color: colors.secondaryText,
              fontSize: ARTICLE_PREVIEW_FONT_SIZE,
              lineClamp: ARTICLE_PREVIEW_MAX_LINES,
              lineHeight: LAYOUT.LINE_HEIGHT,
              width: innerWidth,
            },
            colors.accent,
          ),
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

// X's large link preview: image with the title overlaid, domain underneath.
// Without a usable image the title and domain sit in a bordered box instead.
function linkCardBlock(colors: ThemeColors, contentWidth: number, card: LinkCardData, failedUrls: Set<string>): Node {
  const cover = card.image && !failedUrls.has(card.image.url) ? card.image : null;

  const domainText = text(`From ${card.domain}`, {
    color: colors.secondaryText,
    fontSize: LAYOUT.FONT_SIZE_STATS,
  });

  if (!cover) {
    return box({
      children: [
        domainText,
        text(card.title, {
          color: colors.text,
          fontSize: LINK_CARD_TITLE_FONT_SIZE,
          lineClamp: LINK_CARD_TITLE_MAX_LINES,
          lineHeight: LAYOUT.LINE_HEIGHT,
          marginTop: LAYOUT.TEXT_GAP,
        }),
      ],
      style: {
        borderColor: colors.border,
        borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
        borderStyle: "solid",
        borderWidth: 1,
        marginBottom: BLOCK_GAP_BOTTOM,
        marginTop: LAYOUT.AVATAR_GAP,
        padding: ARTICLE_PADDING,
        width: contentWidth,
      },
    });
  }

  const height = scaledHeight(cover.width, cover.height, contentWidth);

  return box({
    children: [
      box({
        children: [
          image({ src: cover.url, style: { height, objectFit: "cover", width: contentWidth } }),
          box({
            // X keeps the overlay to one line so the title never hides the image.
            children: [text(card.title, { color: "#ffffff", fontSize: LINK_CARD_TITLE_FONT_SIZE, lineClamp: 1 })],
            style: {
              backgroundColor: "rgba(0, 0, 0, 0.75)",
              borderRadius: 4,
              bottom: LINK_CARD_TITLE_INSET,
              left: LINK_CARD_TITLE_INSET,
              maxWidth: contentWidth - LINK_CARD_TITLE_INSET * 2,
              paddingBottom: 2,
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 2,
              position: "absolute",
            },
          }),
        ],
        style: {
          borderColor: colors.border,
          borderRadius: LAYOUT.MEDIA_BORDER_RADIUS,
          borderStyle: "solid",
          borderWidth: 1,
          height,
          overflow: "hidden",
          position: "relative",
          width: contentWidth,
        },
      }),
      box({ children: [domainText], style: { marginTop: LAYOUT.TEXT_GAP } }),
    ],
    style: { marginBottom: BLOCK_GAP_BOTTOM, marginTop: LAYOUT.AVATAR_GAP, width: contentWidth },
  });
}

function mediaBlock(colors: ThemeColors, contentWidth: number, media: MediaItem, failedUrls: Set<string>): Node {
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

function avatarOrFallback(url: string, size: number, colors: ThemeColors, failedUrls?: Set<string>): Node {
  // Missing/blocked avatar URLs render as a plain circular placeholder.
  if (failedUrls?.has(url) === true) {
    return box({
      style: {
        backgroundColor: colors.secondaryText,
        borderRadius: size / 2,
        height: size,
        width: size,
      },
    });
  }

  return image({
    src: url,
    style: { borderRadius: size / 2, height: size, width: size },
  });
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

// BCP47-ish language tag: 2-3 letter code with optional script and region.
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/iu;

// Codes with no meaningful display name; never shown in the badge.
const UNTRANSLATABLE = new Set(["und", "mul", "zxx", "auto"]);

export function getTranslationLanguage(tweet: Pick<TweetData, "translation">): string | null {
  const raw = tweet.translation?.sourceLanguage?.trim();

  if (raw === undefined || raw === "") {
    return null;
  }

  // Upstream leaks its missing-i18n-key fallback ("language_zh", "language-ZH").
  const candidate = raw.replace(/^language[_-]+/iu, "").replaceAll("_", "-");
  const language = candidate === "" ? raw : candidate;

  // Already an English name ("Chinese") rather than a code: DisplayNames would
  // lowercase it, so only normalize the capitalization.
  if (!LANGUAGE_CODE_RE.test(language)) {
    if (UNTRANSLATABLE.has(language.toLowerCase())) {
      return null;
    }

    return language.charAt(0).toUpperCase() + language.slice(1);
  }

  if (UNTRANSLATABLE.has(language.toLowerCase())) {
    return null;
  }

  try {
    const display = languageDisplayNames.of(language);

    // Unknown codes round-trip unchanged; fall back to a capitalized code.
    if (display === undefined || display === "" || display.toLowerCase() === language.toLowerCase()) {
      return language.charAt(0).toUpperCase() + language.slice(1);
    }

    return display;
  } catch {
    return language.charAt(0).toUpperCase() + language.slice(1);
  }
}

const HASHTAG_BLOCK_RE = /\n(?<hashtagBlock>#\S+(?:\s+#\S+)*\s*)$/u;
