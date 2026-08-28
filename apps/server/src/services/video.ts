import path from "node:path";
import { http } from "@starlight/utils/http";
import { Schema } from "effect";
import { create } from "youtube-dl-exec";
import env from "@/env";
import { logger } from "@/logger";

const filesGlob = new Bun.Glob("*.mp4");

// Spawn timeout kills yt-dlp (SIGTERM) so a hung download rejects, runs the
// fallback path, and reaches the temp-dir cleanup instead of pinning the
// update context forever.
const VIDEO_DOWNLOAD_TIMEOUT_MS = 180_000;

export const VideoMetadata = Schema.Struct({
  height: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
});
export type VideoMetadata = typeof VideoMetadata.Type;

export interface VideoInformation {
  filePath: string;
  metadata: VideoMetadata;
}

async function createVideoInformation(filePath: string): Promise<VideoInformation> {
  const parsedPath = path.parse(filePath);

  const infoJsonPath = path.join(parsedPath.dir, `${parsedPath.name}.info.json`);

  logger.debug({ infoJsonPath }, "Creating video information");

  let metadata: VideoMetadata = {};

  try {
    metadata = Schema.decodeUnknownSync(VideoMetadata)(await Bun.file(infoJsonPath).json());
  } catch (error) {
    logger.error({ error, filePath }, "Failed to create video information");
  }

  return {
    filePath,
    metadata,
  };
}

const youtubedl = create(env.YOUTUBE_DL_PATH);

export async function downloadVideoFromUrl(
  url: string,
  folder: string,
  metadata: VideoMetadata = {},
): Promise<VideoInformation> {
  const uuid = Bun.randomUUIDv7();
  const filePath = path.join(folder, `${uuid}.mp4`);

  logger.debug({ url }, "Downloading video directly from URL");

  // ky's `timeout` only bounds time-to-headers; the abort signal also bounds
  // the response body so Bun.write cannot hang on a stalled CDN stream.
  const response = await http(url, {
    signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
  });

  if (!(response.ok && response.body)) {
    throw new Error(`Failed to download video from ${url}: ${response.status}`);
  }

  await Bun.write(filePath, response);

  return { filePath, metadata };
}

export async function downloadVideo(url: string, folder: string): Promise<VideoInformation[]> {
  logger.debug({ folder, url }, "Downloading video");

  const uuid = Bun.randomUUIDv7();

  const subprocess = await youtubedl.exec(
    url,
    {
      paths: folder,
      quiet: true,
      noWarnings: true,
      noPostOverwrites: true,
      noOverwrites: true,
      format: "mp4",
      writeInfoJson: true,
      noCheckCertificates: true,
      output: `${uuid}.%(ext)s`,
    },
    { timeout: VIDEO_DOWNLOAD_TIMEOUT_MS },
  );

  if (subprocess.error) {
    logger.error({ url }, "Failed to download video");
    throw subprocess.error;
  }

  const mp4Files = filesGlob.scan({ cwd: folder });

  const videoInformations: VideoInformation[] = [];

  for await (const filePath of mp4Files) {
    videoInformations.push(await createVideoInformation(path.join(folder, filePath)));
  }

  return videoInformations;
}
