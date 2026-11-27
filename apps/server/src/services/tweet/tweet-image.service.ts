import { http } from "@starlight/utils/http";
import { Effect, Option, Schema } from "effect";
import tmp from "tmp";
import { findEmbeddableVideo, renderTweetImage, renderTweetVideoThemes, SCALE_FACTOR } from "@/services/render";
import type { RenderResult, RenderVideoResult, TweetData } from "@/services/render";
import { LAYOUT } from "@/services/render/layout";
import type { FxEmbedMosaicPhoto, FxEmbedTweet, FxEmbedVideo } from "@/services/fxembed/types";
import { TwitterApi } from "@/services/twitter-api";
import { downloadVideoFromUrl } from "@/services/video";
import { s3 } from "@/storage";

export type Theme = "light" | "dark";

export const TWEET_IMAGE_CACHE_PREFIX = "tweets/v4";
const TWEET_IMAGE_TRANSLATION_LANGUAGE = "en";
const MOSAIC_METADATA_TIMEOUT_MS = 5000;
const VIDEO_SLOT_WIDTH = (LAYOUT.WIDTH - LAYOUT.PADDING * 2) * SCALE_FACTOR;
const VIDEO_DIMENSION_RE = /\/(?<width>\d+)x\d+\//u;

const TweetVideoMetaSchema = Schema.fromJsonString(
  Schema.Struct({
    duration: Schema.Number,
    height: Schema.Number,
    sizeBytes: Schema.Number,
    width: Schema.Number,
  }),
);

export interface CachedTweetVideoMeta {
  duration: number;
  height: number;
  mp4Path: string;
  sizeBytes: number;
  thumbnailPath: string;
  width: number;
}

export function selectBestVideoUrl(video: FxEmbedVideo, targetWidth = VIDEO_SLOT_WIDTH): string {
  const mp4Formats = (video.formats ?? []).filter(
    (format) => format.container === "mp4" || /\.mp4(?:\?|$)/iu.test(format.url),
  );

  if (mp4Formats.length === 0) {
    return video.url;
  }

  const sized = mp4Formats
    .map((format) => {
      const width = Number(VIDEO_DIMENSION_RE.exec(format.url)?.groups?.width);

      return Number.isFinite(width) && width > 0 ? { format, width } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .toSorted((left, right) => left.width - right.width);

  if (sized.length > 0) {
    const fitting = sized.find((entry) => entry.width >= targetWidth);

    return (fitting ?? sized.at(-1))!.format.url;
  }

  const byBitrate = mp4Formats.toSorted((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0));

  return byBitrate[0]?.url ?? video.url;
}

const getMosaicDimensions = Effect.fn("getMosaicDimensions")(
  (mosaic: FxEmbedMosaicPhoto): Effect.Effect<{ width: number; height: number }> =>
    Effect.gen(function* () {
      const hasWidth = (mosaic.width ?? 0) !== 0 && !Number.isNaN(mosaic.width);
      const hasHeight = (mosaic.height ?? 0) !== 0 && !Number.isNaN(mosaic.height);

      if (hasWidth && hasHeight) {
        return { width: mosaic.width!, height: mosaic.height! };
      }

      return yield* Effect.tryPromise({
        try: async () => {
          // Abort signal bounds headers AND body; ky's `timeout` alone only
          // covers time-to-headers, so arrayBuffer() could hang on a stalled stream.
          const response = await http(mosaic.formats.jpeg, {
            signal: AbortSignal.timeout(MOSAIC_METADATA_TIMEOUT_MS),
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch mosaic: ${response.status}`);
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          const metadata = await new Bun.Image(buffer).metadata();

          if (!metadata.width || !metadata.height) {
            throw new Error("Missing metadata");
          }

          return { width: metadata.width, height: metadata.height };
        },
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to read mosaic dimensions", {
            error,
            url: mosaic.formats.jpeg,
          }),
        ),
        Effect.orElseSucceed(() => ({ width: 1200, height: 900 })),
      );
    }),
);

const mapMediaData = Effect.fn("mapMediaData")((media: FxEmbedTweet["media"]): Effect.Effect<TweetData["media"]> =>
  Effect.gen(function* () {
    if (!media) {
      return null;
    }

    let mosaic: NonNullable<TweetData["media"]>["mosaic"];

    if (media.mosaic) {
      const dimensions = yield* getMosaicDimensions(media.mosaic);
      mosaic = {
        url: media.mosaic.url ?? media.mosaic.formats.jpeg,
        width: dimensions.width,
        height: dimensions.height,
        formats: media.mosaic.formats,
      };
    }

    return {
      mosaic,
      photos: media.photos?.map((p) => ({ url: p.url, width: p.width, height: p.height })),
      videos: media.videos?.map((v) => ({
        height: v.height,
        thumbnailUrl: v.thumbnail_url,
        type: v.type,
        url: selectBestVideoUrl(v),
        width: v.width,
      })),
    };
  }),
);

function buildTweetData(tweet: FxEmbedTweet, replyingTo?: string): Effect.Effect<TweetData> {
  return Effect.gen(function* () {
    const media = yield* mapMediaData(tweet.media);
    const translation = tweet.translation?.source_lang === "ru" ? null : tweet.translation;
    const quote = tweet.quote ? yield* buildTweetData(tweet.quote) : null;
    const text = tweet.stripLinkCardUrl(translation?.text ?? tweet.text);

    return {
      authorName: tweet.author.name,
      authorUsername: tweet.author.screen_name,
      authorAvatarUrl: tweet.author.avatar_url,
      card: tweet.getLinkCard(),
      text:
        replyingTo !== undefined && replyingTo !== ""
          ? text.replace(new RegExp(`^@${replyingTo}\\s*`, "iu"), "").trim()
          : text,
      createdAt: new Date(tweet.created_timestamp * 1000),
      media,
      article: tweet.article?.toArticleData() ?? null,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      translation: translation?.toTranslationData() ?? null,
      quote,
    } satisfies TweetData;
  });
}

const MAX_REPLY_CHAIN_DEPTH = 3;

interface ReplyChainResult {
  chain: TweetData[];
  hasMore: boolean;
}

function fetchReplyChain(
  tweetId: string,
  depth = 0,
  childReplyingTo?: string,
): Effect.Effect<ReplyChainResult, TwitterApi.TwitterApiError, TwitterApi.Service> {
  return Effect.gen(function* () {
    if (depth >= MAX_REPLY_CHAIN_DEPTH) {
      return { chain: [], hasMore: true };
    }

    const twitterApi = yield* TwitterApi.Service;
    const tweet = yield* twitterApi.getFxTweet(tweetId, TWEET_IMAGE_TRANSLATION_LANGUAGE);

    if (!tweet) {
      return { chain: [], hasMore: false };
    }

    const tweetData = yield* buildTweetData(tweet, childReplyingTo);

    if (
      tweet.replying_to_status !== undefined &&
      tweet.replying_to_status !== null &&
      tweet.replying_to_status !== ""
    ) {
      const parentResult = yield* fetchReplyChain(tweet.replying_to_status, depth + 1, tweet.replying_to ?? undefined);

      return {
        chain: [...parentResult.chain, tweetData],
        hasMore: parentResult.hasMore,
      };
    }

    return { chain: [tweetData], hasMore: false };
  });
}

export const prepareTweetData = Effect.fn("prepareTweetData")(
  (
    tweetId: string,
    fetchedTweet?: FxEmbedTweet,
  ): Effect.Effect<TweetData, TwitterApi.TwitterApiError | Error, TwitterApi.Service> =>
    Effect.gen(function* () {
      const twitterApi = yield* TwitterApi.Service;
      const tweet = fetchedTweet ?? (yield* twitterApi.getFxTweet(tweetId, TWEET_IMAGE_TRANSLATION_LANGUAGE));

      if (!tweet) {
        yield* Effect.logWarning("Could not fetch tweet", { tweetId });

        return yield* Effect.fail(new Error("Tweet not found"));
      }

      let replyChain: TweetData[] = [];
      let hasMoreInChain = false;

      if (
        tweet.replying_to_status !== undefined &&
        tweet.replying_to_status !== null &&
        tweet.replying_to_status !== ""
      ) {
        const chainResult = yield* fetchReplyChain(tweet.replying_to_status);
        replyChain = chainResult.chain;
        hasMoreInChain = chainResult.hasMore;
      }

      const base = yield* buildTweetData(tweet, replyChain.length > 0 ? (tweet.replying_to ?? undefined) : undefined);

      return {
        ...base,
        replyChain,
        hasMoreInChain,
      };
    }),
);

export type TweetImageResult = RenderResult;

export const generateTweetImage = Effect.fn("generateTweetImage")(
  (
    tweetId: string,
    theme: Theme = "light",
    fetchedTweet?: FxEmbedTweet,
  ): Effect.Effect<RenderResult, TwitterApi.TwitterApiError | Error, TwitterApi.Service> =>
    Effect.gen(function* () {
      const s3Path = `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${theme}.jpg`;
      const s3File = s3.file(s3Path);

      const cachedResult = yield* Effect.tryPromise({
        try: async () => {
          if (await s3File.exists()) {
            const buffer = Buffer.from(await s3File.arrayBuffer());
            const metadata = await new Bun.Image(buffer).metadata();

            return {
              buffer,
              failedUrls: [],
              width: metadata.width ?? 1100,
              height: metadata.height ?? 1200,
            } satisfies RenderResult;
          }

          return null;
        },
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to read cached image from S3, falling back to API", {
            error,
            tweetId,
            theme,
            s3Path,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );

      if (cachedResult) {
        yield* Effect.logDebug("Found cached tweet image in S3", { tweetId, theme, s3Path });

        return cachedResult;
      }

      const tweetData = yield* prepareTweetData(tweetId, fetchedTweet);

      yield* Effect.logDebug("Rendering tweet image", { tweetId, theme });

      const result = yield* Effect.tryPromise({
        try: async () => await renderTweetImage(tweetData, theme),
        catch: (error) => new Error(`Failed to render tweet image: ${String(error)}`),
      });

      // A card that lost an image to a transient fetch must not become the
      // cached result: every later theme toggle or lookup would serve the hole.
      if (result.failedUrls.length > 0) {
        yield* Effect.logWarning("Skipping S3 write for tweet image with failed image fetches", {
          failedUrls: result.failedUrls,
          s3Path,
          theme,
          tweetId,
        });

        return result;
      }

      const uploaded = yield* Effect.tryPromise({
        try: async () => {
          await s3.write(s3Path, result.buffer, { type: "image/jpeg" });

          return true;
        },
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to upload rendered image to S3", {
            error,
            tweetId,
            theme,
            s3Path,
          }),
        ),
        Effect.orElseSucceed(() => false),
      );

      if (uploaded) {
        yield* Effect.logDebug("Uploaded rendered tweet image to S3", { tweetId, theme, s3Path });
      }

      return result;
    }),
);

export type TweetVideoResult = RenderVideoResult;

function tweetVideoS3Paths(tweetId: string, theme: Theme) {
  return {
    metaPath: `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${theme}-video.json`,
    mp4Path: `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${theme}.mp4`,
    thumbnailPath: `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${theme}-video-thumb.jpg`,
  };
}

export const readCachedTweetVideoMeta = Effect.fn("readCachedTweetVideoMeta")(
  (tweetId: string, theme: Theme): Effect.Effect<CachedTweetVideoMeta | null> =>
    Effect.gen(function* () {
      const paths = tweetVideoS3Paths(tweetId, theme);
      const metaFile = s3.file(paths.metaPath);

      return yield* Effect.tryPromise({
        try: async () => {
          if (!(await metaFile.exists())) {
            return null;
          }

          const decoded = Schema.decodeUnknownOption(TweetVideoMetaSchema)(await metaFile.text());

          if (Option.isNone(decoded)) {
            return null;
          }

          return {
            duration: decoded.value.duration,
            height: decoded.value.height,
            mp4Path: paths.mp4Path,
            sizeBytes: decoded.value.sizeBytes,
            thumbnailPath: paths.thumbnailPath,
            width: decoded.value.width,
          } satisfies CachedTweetVideoMeta;
        },
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to read cached tweet video metadata from S3", {
            error,
            metaPath: paths.metaPath,
            theme,
            tweetId,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    }),
);

async function readCachedTweetVideoFromS3(tweetId: string, theme: Theme): Promise<RenderVideoResult | null> {
  const paths = tweetVideoS3Paths(tweetId, theme);
  const metaFile = s3.file(paths.metaPath);

  if (!(await metaFile.exists())) {
    return null;
  }

  const decoded = Schema.decodeUnknownOption(TweetVideoMetaSchema)(await metaFile.text());

  if (Option.isNone(decoded)) {
    return null;
  }

  const mp4File = s3.file(paths.mp4Path);
  const thumbnailFile = s3.file(paths.thumbnailPath);

  if (!(await mp4File.exists()) || !(await thumbnailFile.exists())) {
    return null;
  }

  const [mp4Bytes, thumbnailBytes] = await Promise.all([mp4File.arrayBuffer(), thumbnailFile.arrayBuffer()]);

  return {
    buffer: Buffer.from(mp4Bytes),
    duration: decoded.value.duration,
    failedUrls: [],
    height: decoded.value.height,
    thumbnail: Buffer.from(thumbnailBytes),
    width: decoded.value.width,
  };
}

async function writeTweetVideoToS3(tweetId: string, theme: Theme, result: RenderVideoResult): Promise<void> {
  const paths = tweetVideoS3Paths(tweetId, theme);

  await Promise.all([
    s3.write(paths.mp4Path, result.buffer, { type: "video/mp4" }),
    s3.write(paths.thumbnailPath, result.thumbnail, { type: "image/jpeg" }),
  ]);

  // Write metadata after the media objects so readers never see a metadata entry for an unuploaded video.
  await s3.write(
    paths.metaPath,
    JSON.stringify({
      duration: result.duration,
      height: result.height,
      sizeBytes: result.buffer.length,
      width: result.width,
    }),
    { type: "application/json" },
  );
}

async function downloadSourceVideo(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  folder: string,
): Promise<string> {
  try {
    const downloaded = await downloadVideoFromUrl(primaryUrl, folder);

    return downloaded.filePath;
  } catch (error) {
    if (fallbackUrl === undefined || fallbackUrl === primaryUrl) {
      throw error;
    }

    const fallback = await downloadVideoFromUrl(fallbackUrl, folder);

    return fallback.filePath;
  }
}

const ALL_THEMES: readonly Theme[] = ["light", "dark"];
const inFlightTweetVideoRenders = new Map<string, Promise<Map<Theme, RenderVideoResult>>>();

function startRenderBothThemes(
  tweetId: string,
  tweetData: TweetData,
  fetchedTweet: FxEmbedTweet | undefined,
): Effect.Effect<Map<Theme, RenderVideoResult>, Error> {
  return Effect.gen(function* () {
    const existing = inFlightTweetVideoRenders.get(tweetId);

    if (existing) {
      return yield* Effect.tryPromise({
        try: async () => await existing,
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    }

    const embeddable = findEmbeddableVideo(tweetData);
    const videoUrl = embeddable?.video.url;

    if (!embeddable || videoUrl === undefined || videoUrl === "") {
      return yield* Effect.fail(new Error("Tweet has no video"));
    }

    const fallbackUrl =
      embeddable.target === tweetData
        ? fetchedTweet?.media?.videos?.at(0)?.url
        : fetchedTweet?.quote?.media?.videos?.at(0)?.url;

    const renderPromise = (async (): Promise<Map<Theme, RenderVideoResult>> => {
      const tempDir = tmp.dirSync({ unsafeCleanup: true });

      try {
        const sourcePath = await downloadSourceVideo(videoUrl, fallbackUrl, tempDir.name);
        const videos = await renderTweetVideoThemes(tweetData, sourcePath, ALL_THEMES);

        await Promise.all(
          ALL_THEMES.map(async (theme) => {
            const rendered = videos.get(theme);

            if (!rendered || rendered.failedUrls.length > 0) {
              return;
            }

            try {
              await writeTweetVideoToS3(tweetId, theme, rendered);
            } catch {
              // S3 caching is best-effort; callers still receive the in-memory rendered buffer.
            }
          }),
        );

        return videos;
      } finally {
        tempDir.removeCallback();
      }
    })();

    inFlightTweetVideoRenders.set(tweetId, renderPromise);

    return yield* Effect.tryPromise({
      try: async () => await renderPromise,
      catch: (error) => new Error(`Failed to render tweet video: ${String(error)}`),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          inFlightTweetVideoRenders.delete(tweetId);
        }),
      ),
    );
  });
}

export const generateTweetVideo = Effect.fn("generateTweetVideo")(
  (
    tweetId: string,
    theme: Theme = "light",
    fetchedTweet?: FxEmbedTweet,
  ): Effect.Effect<RenderVideoResult, TwitterApi.TwitterApiError | Error, TwitterApi.Service> =>
    Effect.gen(function* () {
      const cachedResult = yield* Effect.tryPromise({
        try: async () => await readCachedTweetVideoFromS3(tweetId, theme),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to read cached tweet video from S3, falling back to render", {
            error,
            theme,
            tweetId,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );

      if (cachedResult) {
        yield* Effect.logDebug("Found cached tweet video in S3", { theme, tweetId });

        return cachedResult;
      }

      const tweetData = yield* prepareTweetData(tweetId, fetchedTweet);
      const videos = yield* startRenderBothThemes(tweetId, tweetData, fetchedTweet);
      const result = videos.get(theme);

      if (!result) {
        return yield* Effect.fail(new Error(`Failed to render tweet video for theme ${theme}`));
      }

      if (result.failedUrls.length > 0) {
        yield* Effect.logWarning("Skipped S3 write for tweet video with failed image fetches", {
          failedUrls: result.failedUrls,
          theme,
          tweetId,
        });
      }

      return result;
    }),
);
