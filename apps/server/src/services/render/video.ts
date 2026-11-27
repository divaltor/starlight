import path from "node:path";
import { Option, Schema } from "effect";
import sharp from "sharp";
import tmp from "tmp";
import { logger } from "@/logger";

export interface RenderVideoResult {
  buffer: Buffer;
  duration: number;
  failedUrls: string[];
  height: number;
  thumbnail: Buffer;
  width: number;
}

export interface CompositeVideoVariant<Key extends string = string> {
  background: string;
  failedUrls: string[];
  key: Key;
  png: Buffer;
  thumbnailFailed: boolean;
}

export interface CompositeTweetVideosParams<Key extends string = string> {
  borderRadius: number;
  height: number;
  maxBytes?: number;
  slot: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  variants: readonly CompositeVideoVariant<Key>[];
  videoPath: string;
  width: number;
}

const FFMPEG_TIMEOUT_MS = 180_000;
const FFPROBE_TIMEOUT_MS = 15_000;
const MAX_VIDEO_FPS = 30;
const THUMBNAIL_WIDTH = 320;

// Leaves headroom under Telegram's 20 MB URL-fetch cap (inline) and well under the 50 MB upload cap.
export const MAX_RENDERED_VIDEO_BYTES = Math.floor(19.5 * 1024 * 1024);

const FfprobeOutput = Schema.fromJsonString(
  Schema.Struct({
    format: Schema.optional(
      Schema.Struct({
        duration: Schema.optional(Schema.String),
      }),
    ),
    streams: Schema.optional(
      Schema.Array(
        Schema.Struct({
          avg_frame_rate: Schema.optional(Schema.String),
          bit_rate: Schema.optional(Schema.String),
          codec_name: Schema.optional(Schema.String),
          codec_type: Schema.optional(Schema.String),
          r_frame_rate: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);

interface VideoProbe {
  audioBitrate: number | null;
  audioCodec: string | null;
  duration: number;
  fps: number | null;
}

export function computeBitrateBudget(params: {
  audioBitrate: number | null;
  audioCodec: string | null;
  duration: number;
  maxBytes: number;
}): { audioCopy: boolean; audioKbps: number; videoMaxKbps: number } {
  const duration = Math.max(1, params.duration);
  // Reserve 8% for MP4 container and muxing overhead.
  const totalBps = Math.floor((params.maxBytes * 8 * 0.92) / duration);

  if (params.audioCodec === null) {
    return {
      audioCopy: false,
      audioKbps: 0,
      videoMaxKbps: Math.max(120, Math.floor(totalBps / 1000)),
    };
  }

  const maxAudioBps = totalBps > 256_000 ? 128_000 : 64_000;
  const sourceAudioBps = params.audioBitrate ?? 128_000;
  const audioCopy = params.audioCodec === "aac" && sourceAudioBps <= maxAudioBps;
  const effectiveAudioBps = audioCopy ? sourceAudioBps : Math.min(sourceAudioBps, maxAudioBps);

  return {
    audioCopy,
    audioKbps: Math.max(32, Math.floor(effectiveAudioBps / 1000)),
    videoMaxKbps: Math.max(120, Math.floor((totalBps - effectiveAudioBps) / 1000)),
  };
}

function parseFrameRate(rate: string | undefined): number | null {
  if (rate === undefined || rate === "" || rate === "0/0") {
    return null;
  }

  const [numeratorRaw, denominatorRaw] = rate.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = denominatorRaw === undefined ? 1 : Number(denominatorRaw);

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0 || numerator <= 0) {
    return null;
  }

  return numerator / denominator;
}

async function runProcess(args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(args, {
    stderr: "pipe",
    stdout: "pipe",
  });

  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      throw new Error(`${args[0]} timed out after ${timeoutMs}ms`);
    }

    if (exitCode !== 0) {
      throw new Error(`${args[0]} exited with code ${exitCode}: ${stderr.trim()}`);
    }

    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function probeVideo(videoPath: string): Promise<VideoProbe> {
  const stdout = await runProcess(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,bit_rate,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      videoPath,
    ],
    FFPROBE_TIMEOUT_MS,
  );

  const parsed = Schema.decodeUnknownOption(FfprobeOutput)(stdout);

  if (Option.isNone(parsed)) {
    return { audioBitrate: null, audioCodec: null, duration: 1, fps: null };
  }

  const videoStream = parsed.value.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = parsed.value.streams?.find((stream) => stream.codec_type === "audio");
  const rawDuration = Number(parsed.value.format?.duration);
  const rawAudioBitrate = Number(audioStream?.bit_rate);

  return {
    audioBitrate: Number.isFinite(rawAudioBitrate) && rawAudioBitrate > 0 ? rawAudioBitrate : null,
    audioCodec: audioStream?.codec_name ?? null,
    duration: Number.isFinite(rawDuration) && rawDuration > 0 ? Math.max(1, Math.round(rawDuration)) : 1,
    fps: parseFrameRate(videoStream?.avg_frame_rate) ?? parseFrameRate(videoStream?.r_frame_rate),
  };
}

export async function compositeTweetVideos<Key extends string>(
  params: CompositeTweetVideosParams<Key>,
): Promise<Map<Key, RenderVideoResult>> {
  if (params.variants.length === 0) {
    return new Map();
  }

  const cutoutMask = Buffer.from(
    `<svg width="${params.width}" height="${params.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="${params.slot.x}" y="${params.slot.y}" width="${params.slot.width}" height="${params.slot.height}" rx="${params.borderRadius}" ry="${params.borderRadius}" fill="white"/>` +
      `</svg>`,
  );

  const prepared = await Promise.all(
    params.variants.map(async (variant) => {
      // Flatten onto the theme background first so odd-height padding never leaves stray alpha outside the video slot.
      const opaqueCard = await sharp(variant.png)
        .flatten({ background: variant.background })
        .ensureAlpha()
        .png()
        .toBuffer();

      const overlayPng = await sharp(opaqueCard)
        .composite([{ blend: "dest-out", input: cutoutMask }])
        .png()
        .toBuffer();

      return { opaqueCard, overlayPng, variant };
    }),
  );

  // Keep pad offsets and scaled dimensions even for yuv420p; any 1px overscan is clipped by the exact alpha mask.
  const padX = params.slot.x - (params.slot.x % 2);
  const padY = params.slot.y - (params.slot.y % 2);
  const rawScaleW = params.slot.width + (params.slot.x % 2) * 2;
  const rawScaleH = params.slot.height + (params.slot.y % 2) * 2;
  const scaleW = rawScaleW + (rawScaleW % 2);
  const scaleH = rawScaleH + (rawScaleH % 2);

  const probe = await probeVideo(params.videoPath);
  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  try {
    const filePairs = await Promise.all(
      prepared.map(async (item, index) => {
        const overlayPath = path.join(tempDir.name, `overlay-${index}.png`);
        const outputPath = path.join(tempDir.name, `output-${index}.mp4`);
        await Bun.write(overlayPath, item.overlayPng);

        return { ...item, index, outputPath, overlayPath };
      }),
    );

    const maxBytes = params.maxBytes ?? MAX_RENDERED_VIDEO_BYTES;
    const fpsFilter = probe.fps !== null && probe.fps > MAX_VIDEO_FPS + 0.5 ? `fps=${MAX_VIDEO_FPS},` : "";
    const baseChain = `[0:v]${fpsFilter}scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH},pad=${params.width}:${params.height}:${padX}:${padY}:color=black`;

    const encodePairs = async (targets: typeof filePairs, crf: number, targetMaxBytes: number): Promise<void> => {
      const budget = computeBitrateBudget({
        audioBitrate: probe.audioBitrate,
        audioCodec: probe.audioCodec,
        duration: probe.duration,
        maxBytes: targetMaxBytes,
      });

      const splitPads = targets.map((_, idx) => `[bg${idx}]`).join("");

      // Decode, scale, and pad the input video once, then split across every theme overlay in a single ffmpeg pass.
      const filterSteps =
        targets.length === 1
          ? [
              `${baseChain}[bg0]`,
              "[1:v]format=yuva420p[ov0]",
              "[bg0][ov0]overlay=0:0:eof_action=repeat:format=yuv420[v0]",
            ]
          : [
              `${baseChain},split=${targets.length}${splitPads}`,
              ...targets.flatMap((_, idx) => [
                `[${idx + 1}:v]format=yuva420p[ov${idx}]`,
                `[bg${idx}][ov${idx}]overlay=0:0:eof_action=repeat:format=yuv420[v${idx}]`,
              ]),
            ];

      const audioArgs =
        probe.audioCodec === null
          ? []
          : [
              "-map",
              "0:a?",
              ...(budget.audioCopy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", `${budget.audioKbps}k`]),
            ];

      const inputArgs = targets.flatMap((item) => ["-i", item.overlayPath]);

      const outputArgs = targets.flatMap((item, idx) => [
        "-map",
        `[v${idx}]`,
        ...audioArgs,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        String(crf),
        "-maxrate",
        `${budget.videoMaxKbps}k`,
        "-bufsize",
        `${budget.videoMaxKbps * 2}k`,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        item.outputPath,
      ]);

      await runProcess(
        [
          "ffmpeg",
          "-y",
          "-v",
          "error",
          "-i",
          params.videoPath,
          ...inputArgs,
          "-filter_complex",
          filterSteps.join(";"),
          ...outputArgs,
        ],
        FFMPEG_TIMEOUT_MS,
      );
    };

    await encodePairs(filePairs, 23, maxBytes);

    const oversized = filePairs.filter((item) => Bun.file(item.outputPath).size > maxBytes);

    if (oversized.length > 0) {
      await encodePairs(oversized, 28, Math.floor(maxBytes * 0.82));
    }

    const entries = await Promise.all(
      filePairs.map(async (item): Promise<readonly [Key, RenderVideoResult]> => {
        const buffer = Buffer.from(await Bun.file(item.outputPath).arrayBuffer());

        let thumbnail: Buffer;

        if (item.variant.thumbnailFailed) {
          const framePath = path.join(tempDir.name, `thumb-${item.index}.png`);
          await runProcess(
            ["ffmpeg", "-y", "-v", "error", "-i", item.outputPath, "-frames:v", "1", framePath],
            FFPROBE_TIMEOUT_MS,
          );
          thumbnail = await sharp(Buffer.from(await Bun.file(framePath).arrayBuffer()))
            .resize({ width: THUMBNAIL_WIDTH })
            .jpeg({ quality: 80 })
            .toBuffer();
        } else {
          thumbnail = await sharp(item.opaqueCard).resize({ width: THUMBNAIL_WIDTH }).jpeg({ quality: 80 }).toBuffer();
        }

        return [
          item.variant.key,
          {
            buffer,
            duration: probe.duration,
            failedUrls: item.variant.failedUrls,
            height: params.height,
            thumbnail,
            width: params.width,
          },
        ] as const;
      }),
    );

    logger.debug(
      {
        duration: probe.duration,
        height: params.height,
        sizes: Object.fromEntries(entries.map(([key, value]) => [key, value.buffer.length])),
        width: params.width,
      },
      "Rendered tweet video",
    );

    return new Map(entries);
  } finally {
    tempDir.removeCallback();
  }
}
