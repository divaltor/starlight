import { logger } from "@/logger";
import { http } from "@starlight/utils/http";
import path from "node:path";
import sharp from "sharp";
import type { Node } from "takumi-js";
import { Renderer } from "takumi-js/node";
import { extractEmojis } from "takumi-js/helpers/emoji";
import { buildTweetCard, collectRemoteImageSrcs, collectTweetImageUrls, stripUnavailableImages } from "./card";
import { LAYOUT } from "./layout";
import { themes } from "./themes";
import type { Theme } from "./themes";

export interface ArticleCoverMedia {
  height: number;
  url: string;
  width: number;
}

export interface ArticleData {
  coverMedia?: ArticleCoverMedia | null;
  previewText: string;
  title: string;
}

export interface TweetData {
  article?: ArticleData | null;
  authorAvatarUrl: string;
  authorName: string;
  authorUsername: string;
  createdAt?: Date | null;
  hasMoreInChain?: boolean;
  likes?: number | null;
  media?: {
    mosaic?: {
      formats: {
        jpeg: string;
        webp: string;
      };
      height: number;
      url: string;
      width: number;
    };
    photos?: { url: string; width: number; height: number }[];
    videos?: {
      thumbnailUrl: string;
      width: number;
      height: number;
      type: "video" | "gif";
    }[];
  } | null;
  quote?: TweetData | null;
  replies?: number | null;
  replyChain?: TweetData[];
  retweets?: number | null;
  text: string;
  translation?: {
    sourceLanguage: string;
  } | null;
}

export interface RenderResult {
  buffer: Buffer;
  height: number;
  width: number;
}

export type { Theme } from "./themes";

const FONT_FAMILIES = ["Inter", "Noto Sans", "Noto Sans CJK", "Noto Sans Math"];
const IMAGE_FETCH_TIMEOUT_MS = 5000;
// The napi build ignores `devicePixelRatio` when both width and height are
// given, so the 2x output scale is applied to the tree itself instead.
const SCALE_FACTOR = 2;
// Scaling unitless values made lineHeight 2.8 and expanded every text block.
const UNITLESS_STYLE_PROPERTIES = new Set(["flexGrow", "fontWeight", "lineHeight"]);

function scaleNode(node: Node, factor: number): Node {
  if (node.style) {
    scaleStyle(node.style, factor);
  }
  if (node.type === "container") {
    node.children = (node.children ?? []).map((child) => scaleNode(child, factor));
  }
  return node;
}

function scaleStyle(style: NonNullable<Node["style"]>, factor: number): void {
  for (const [prop, value] of Object.entries(style)) {
    if (typeof value === "number" && !UNITLESS_STYLE_PROPERTIES.has(prop)) {
      // Style objects come from our own literals, so a numeric index view is safe here.
      (style as Record<string, number>)[prop] = value * factor;
    }
  }
}

// Fonts live next to the process working directory (see apps/server README);
// Takumi never reads system fonts, so every family below ships in the repo.
function fontAssets(): { file: string; name: string; weight?: number }[] {
  const fontPath = path.join(process.cwd(), "assets", "fonts");

  return [
    { name: "Inter", weight: 400, file: "Inter-Regular.ttf" },
    { name: "Inter", weight: 700, file: "Inter-Bold.ttf" },
    { name: "Noto Sans", file: "NotoSans-Regular.ttf" },
    { name: "Noto Sans CJK", file: "NotoSansCJKsc-Regular.otf" },
    { name: "Noto Sans Math", file: "NotoSansMath-Regular.ttf" },
  ].map((font) => ({ ...font, file: path.join(fontPath, font.file) }));
}

let rendererPromise: Promise<Renderer> | null = null;

function getRenderer(): Promise<Renderer> {
  rendererPromise ??= (async () => {
    const renderer = new Renderer();
    await Promise.all(
      fontAssets().map(async (font) => {
        try {
          const data = await Bun.file(font.file).arrayBuffer();
          await renderer.registerFont({ name: font.name, weight: font.weight, data });
        } catch (error) {
          logger.warn({ error, name: font.name }, "Failed to register font");
        }
      }),
    );
    return renderer;
  })();
  return rendererPromise;
}

async function prefetchImages(urls: Iterable<string>): Promise<Map<string, Uint8Array>> {
  const entries = await Promise.all(
    [...urls].map(async (url) => {
      try {
        // Abort signal bounds headers AND body; ky's `timeout` alone only
        // covers time-to-headers, so arrayBuffer() could hang on a stalled stream.
        const response = await http(url, {
          signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        // A successful response can contain an HTML error page, which makes Takumi abort the card.
        // Use sharp because extracted Twemoji assets are SVG, which Bun.Image cannot decode.
        await sharp(data).metadata();
        return [url, data] as const;
      } catch (error) {
        logger.warn({ error, url }, "Failed to load image for tweet card");
        return null;
      }
    }),
  );

  return new Map(entries.filter((entry) => entry !== null));
}

export async function renderTweetImage(tweet: TweetData, theme: Theme): Promise<RenderResult> {
  const renderer = await getRenderer();
  const colors = themes[theme];

  const mediaUrls = collectTweetImageUrls(tweet);
  const mediaBytes = await prefetchImages(mediaUrls);
  const failedUrls = new Set([...mediaUrls].filter((url) => !mediaBytes.has(url)));

  let node: Node = buildTweetCard({ colors, failedUrls, tweet });
  node = extractEmojis(node, "twemoji");

  const emojiUrls = [...collectRemoteImageSrcs(node)].filter((url) => !mediaBytes.has(url));
  const emojiBytes = await prefetchImages(emojiUrls);

  const bytesBySrc = new Map([...mediaBytes, ...emojiBytes]);
  stripUnavailableImages(node, bytesBySrc);
  node = scaleNode(node, SCALE_FACTOR);

  const measured = await renderer.measure(node, { width: LAYOUT.WIDTH * SCALE_FACTOR });

  const buffer = await renderer.render(node, {
    fontFamilies: FONT_FAMILIES,
    format: "jpeg",
    height: measured.height,
    images: [...bytesBySrc.entries()].map(([src, data]) => ({ data, src })),
    quality: 100,
    width: LAYOUT.WIDTH * SCALE_FACTOR,
  });

  logger.debug(
    {
      height: measured.height,
      size: buffer.length,
      width: LAYOUT.WIDTH * SCALE_FACTOR,
    },
    "Rendered tweet image",
  );

  return {
    buffer: Buffer.from(buffer),
    height: measured.height,
    width: LAYOUT.WIDTH * SCALE_FACTOR,
  };
}
