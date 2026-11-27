import path from "node:path";
import { expect, test } from "bun:test";
import sharp from "sharp";
import tmp from "tmp";

test("falls back when an image URL returns invalid bytes", async () => {
  const { renderTweetImage } = await import("@/services/render");

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("<html>not an image</html>", { status: 200 }),
  });

  try {
    const result = await renderTweetImage(
      {
        authorAvatarUrl: server.url.toString(),
        authorName: "Test author",
        authorUsername: "test",
        text: "The card still renders",
      },
      "light",
    );

    expect(await new Bun.Image(result.buffer).metadata()).toMatchObject({
      height: result.height,
      width: result.width,
    });
  } finally {
    await server.stop(true);
  }
});

test("renders connector between avatars when reply is shorter than avatar", async () => {
  const { renderTweetImage } = await import("@/services/render");

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("<html>not an image</html>", { status: 200 }),
  });

  try {
    const result = await renderTweetImage(
      {
        authorAvatarUrl: server.url.toString(),
        authorName: "Final author",
        authorUsername: "final",
        replyChain: [
          {
            authorAvatarUrl: server.url.toString(),
            authorName: "Reply author",
            authorUsername: "reply",
            text: "Short reply",
          },
        ],
        text: "Final tweet",
      },
      "light",
    );

    const connectorRow = await sharp(result.buffer)
      .extract({ height: 1, left: 82, top: 166, width: 30 })
      .raw()
      .toBuffer();

    const pixel = (x: number) => [...connectorRow.subarray(x * 3, x * 3 + 3)];

    expect(pixel(0).every((channel) => channel > 240)).toBeTrue();
    expect(pixel(14)).toEqual([209, 217, 220]);
    expect(pixel(15)).toEqual([208, 217, 222]);
    expect(pixel(16)).toEqual([208, 217, 222]);
    expect(pixel(17)).toEqual([209, 217, 220]);
    expect(pixel(29).every((channel) => channel > 240)).toBeTrue();
  } finally {
    await server.stop(true);
  }
});

test("retries a failed media fetch so the card still shows the image", async () => {
  const { renderTweetImage } = await import("@/services/render");

  const red = await sharp({ create: { background: "#ff0000", channels: 3, height: 8, width: 8 } })
    .jpeg()
    .toBuffer();

  const blue = await sharp({ create: { background: "#0000ff", channels: 3, height: 8, width: 8 } })
    .jpeg()
    .toBuffer();

  let mediaAttempts = 0;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname !== "/media.jpg") {
        return new Response(blue, { headers: { "content-type": "image/jpeg" } });
      }

      mediaAttempts += 1;

      return mediaAttempts === 1
        ? new Response("temporary outage", { status: 503 })
        : new Response(red, { headers: { "content-type": "image/jpeg" } });
    },
  });

  try {
    const base = server.url.toString();

    const result = await renderTweetImage(
      {
        authorAvatarUrl: `${base}avatar.jpg`,
        authorName: "Test author",
        authorUsername: "test",
        media: { photos: [{ url: `${base}media.jpg`, width: 300, height: 150 }] },
        text: "The card keeps its media",
      },
      "light",
    );

    expect(result.failedUrls).toEqual([]);
    expect(
      await countPixels(result.buffer, (pixel) => pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60),
    ).toBeGreaterThan(1000);
  } finally {
    await server.stop(true);
  }
});

// The cache layer skips its write when this list is non-empty, so it must name
// the images the card lost instead of reporting a clean render.
test("reports the media URL when the image never loads", async () => {
  const { renderTweetImage } = await import("@/services/render");

  const blue = await sharp({ create: { background: "#0000ff", channels: 3, height: 8, width: 8 } })
    .jpeg()
    .toBuffer();

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      return pathname === "/media.jpg"
        ? new Response("permanent outage", { status: 503 })
        : new Response(blue, { headers: { "content-type": "image/jpeg" } });
    },
  });

  try {
    const base = server.url.toString();
    const mediaUrl = `${base}media.jpg`;

    const result = await renderTweetImage(
      {
        authorAvatarUrl: `${base}avatar.jpg`,
        authorName: "Test author",
        authorUsername: "test",
        media: { photos: [{ url: mediaUrl, width: 300, height: 150 }] },
        text: "The card loses its media",
      },
      "light",
    );

    expect(result.failedUrls).toEqual([mediaUrl]);
    expect(await new Bun.Image(result.buffer).metadata()).toMatchObject({
      height: result.height,
      width: result.width,
    });
  } finally {
    await server.stop(true);
  }
});

async function countPixels(buffer: Buffer, predicate: (pixel: [number, number, number]) => boolean): Promise<number> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let count = 0;

  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (predicate([data[offset]!, data[offset + 1]!, data[offset + 2]!])) {
      count += 1;
    }
  }

  return count;
}

// Product rule: embedded tweet videos must play inside the card's media slot
// with even H.264 dimensions and without the static play-button overlay.
test.each(["main", "quote"] as const)(
  "test_embeds_video_into_card_without_play_button_when_video_is_in_%s",
  async (placement) => {
    const { renderTweetVideo } = await import("@/services/render");

    const blue = await sharp({ create: { background: "#0000ff", channels: 3, height: 8, width: 8 } })
      .jpeg()
      .toBuffer();

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(blue, { headers: { "content-type": "image/jpeg" } }),
    });

    const tempDir = tmp.dirSync({ unsafeCleanup: true });

    try {
      const sourcePath = path.join(tempDir.name, "source.mp4");
      const outPath = path.join(tempDir.name, "out.mp4");
      const framePath = path.join(tempDir.name, "frame.png");

      const gen = Bun.spawnSync([
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x00ff00:s=160x90:d=1:r=24",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        sourcePath,
      ]);

      expect(gen.exitCode).toBe(0);

      const base = server.url.toString();

      const videoMedia = {
        videos: [{ height: 90, thumbnailUrl: `${base}thumb.jpg`, type: "video" as const, width: 160 }],
      };

      const tweet =
        placement === "main"
          ? {
              authorAvatarUrl: `${base}avatar.jpg`,
              authorName: "Test author",
              authorUsername: "test",
              media: videoMedia,
              text: "Main video card",
            }
          : {
              authorAvatarUrl: `${base}avatar.jpg`,
              authorName: "Quoter",
              authorUsername: "quoter",
              quote: {
                authorAvatarUrl: `${base}avatar.jpg`,
                authorName: "Original",
                authorUsername: "orig",
                media: videoMedia,
                text: "Quoted video card",
              },
              text: "Check this out",
            };

      const result = await renderTweetVideo(tweet, "light", sourcePath);

      expect(result.failedUrls).toEqual([]);
      expect(result.width % 2).toBe(0);
      expect(result.height % 2).toBe(0);
      expect(result.duration).toBe(1);
      expect(result.thumbnail.length).toBeGreaterThan(0);

      await Bun.write(outPath, result.buffer);
      const extract = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", "-i", outPath, "-frames:v", "1", framePath]);
      expect(extract.exitCode).toBe(0);

      const frame = Buffer.from(await Bun.file(framePath).arrayBuffer());
      const greenPixels = await countPixels(frame, (pixel) => pixel[1] > 180 && pixel[0] < 80 && pixel[2] < 80);
      expect(greenPixels).toBeGreaterThan(100_000);

      // Verify no white play-button triangle sits at the center of the video area.
      const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
      let minY = info.height;
      let maxY = 0;

      for (let y = 0; y < info.height; y += 1) {
        const offset = (y * info.width + Math.floor(info.width / 2)) * info.channels;

        if (data[offset + 1]! > 180 && data[offset]! < 80 && data[offset + 2]! < 80) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }

      const centerOffset = (Math.floor((minY + maxY) / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
      expect(data[centerOffset]!).toBeLessThan(80);
      expect(data[centerOffset + 1]!).toBeGreaterThan(180);
      expect(data[centerOffset + 2]!).toBeLessThan(80);
    } finally {
      tempDir.removeCallback();
      await server.stop(true);
    }
  },
);

// Rendering both themes in one ffmpeg pass must produce distinct light and dark cards with the embedded video.
test("test_renders_light_and_dark_video_themes_in_single_pass", async () => {
  const { renderTweetVideoThemes } = await import("@/services/render");

  const blue = await sharp({ create: { background: "#0000ff", channels: 3, height: 8, width: 8 } })
    .jpeg()
    .toBuffer();

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(blue, { headers: { "content-type": "image/jpeg" } }),
  });

  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  try {
    const sourcePath = path.join(tempDir.name, "source.mp4");

    const gen = Bun.spawnSync([
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x00ff00:s=160x90:d=1:r=24",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      sourcePath,
    ]);

    expect(gen.exitCode).toBe(0);

    const base = server.url.toString();

    const results = await renderTweetVideoThemes(
      {
        authorAvatarUrl: `${base}avatar.jpg`,
        authorName: "Test author",
        authorUsername: "test",
        media: { videos: [{ height: 90, thumbnailUrl: `${base}thumb.jpg`, type: "video", width: 160 }] },
        text: "Both themes together",
      },
      sourcePath,
    );

    const light = results.get("light")!;
    const dark = results.get("dark")!;

    expect(light.width).toBe(dark.width);
    expect(light.height).toBe(dark.height);

    const lightOut = path.join(tempDir.name, "light.mp4");
    const darkOut = path.join(tempDir.name, "dark.mp4");
    const lightFramePath = path.join(tempDir.name, "light.png");
    const darkFramePath = path.join(tempDir.name, "dark.png");

    await Promise.all([Bun.write(lightOut, light.buffer), Bun.write(darkOut, dark.buffer)]);
    expect(
      Bun.spawnSync(["ffmpeg", "-y", "-v", "error", "-i", lightOut, "-frames:v", "1", lightFramePath]).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["ffmpeg", "-y", "-v", "error", "-i", darkOut, "-frames:v", "1", darkFramePath]).exitCode,
    ).toBe(0);

    const [lightTop, darkTop] = await Promise.all([
      sharp(lightFramePath).extract({ height: 1, left: 10, top: 10, width: 1 }).raw().toBuffer(),
      sharp(darkFramePath).extract({ height: 1, left: 10, top: 10, width: 1 }).raw().toBuffer(),
    ]);

    expect(lightTop[0]!).toBeGreaterThan(220);
    expect(darkTop[0]!).toBeLessThan(40);
  } finally {
    tempDir.removeCallback();
    await server.stop(true);
  }
});

// Product rule: rendered tweet videos must stay within Telegram's 20 MB URL-fetch cap even on long clips.
test.each([
  {
    audioBitrate: 128_000,
    audioCodec: "aac",
    duration: 141,
    expectedAudioCopy: true,
    maxVideoKbpsAtMost: 1000,
    name: "medium_aac_video_preserves_audio_copy",
  },
  {
    audioBitrate: 320_000,
    audioCodec: "aac",
    duration: 600,
    expectedAudioCopy: false,
    maxVideoKbpsAtMost: 200,
    name: "long_high_bitrate_audio_reencodes_to_fit_budget",
  },
  {
    audioBitrate: null,
    audioCodec: null,
    duration: 300,
    expectedAudioCopy: false,
    maxVideoKbpsAtMost: 550,
    name: "silent_video_uses_full_budget_for_video",
  },
])("test_computes_telegram_size_budget_when_$name", async (params) => {
  const { computeBitrateBudget, MAX_RENDERED_VIDEO_BYTES } = await import("@/services/render/video");

  const budget = computeBitrateBudget({
    audioBitrate: params.audioBitrate,
    audioCodec: params.audioCodec,
    duration: params.duration,
    maxBytes: MAX_RENDERED_VIDEO_BYTES,
  });

  expect(budget.audioCopy).toBe(params.expectedAudioCopy);
  expect(budget.videoMaxKbps).toBeGreaterThanOrEqual(120);
  expect(budget.videoMaxKbps).toBeLessThanOrEqual(params.maxVideoKbpsAtMost);
  expect(((budget.videoMaxKbps + budget.audioKbps) * 1000 * params.duration) / 8).toBeLessThanOrEqual(
    MAX_RENDERED_VIDEO_BYTES,
  );
});
