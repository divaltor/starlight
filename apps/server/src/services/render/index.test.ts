import { expect, test } from "bun:test";
import sharp from "sharp";

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

test("renders light card bottom corners without dark pixels", async () => {
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
        text: "The card has clean corners",
      },
      "light",
    );

    const leftCorner = await sharp(result.buffer)
      .extract({ height: 1, left: 0, top: result.height - 1, width: 1 })
      .raw()
      .toBuffer();

    const rightCorner = await sharp(result.buffer)
      .extract({ height: 1, left: result.width - 1, top: result.height - 1, width: 1 })
      .raw()
      .toBuffer();

    expect([...leftCorner]).toEqual([255, 255, 255]);
    expect([...rightCorner]).toEqual([255, 255, 255]);
  } finally {
    await server.stop(true);
  }
});

test("renders both bottom corner pixels as white on a light card", async () => {
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
        text: "The card has clean corners",
      },
      "light",
    );

    const leftCorner = await sharp(result.buffer)
      .extract({ height: 1, left: 0, top: result.height - 1, width: 1 })
      .raw()
      .toBuffer();

    const rightCorner = await sharp(result.buffer)
      .extract({ height: 1, left: result.width - 1, top: result.height - 1, width: 1 })
      .raw()
      .toBuffer();

    expect([...leftCorner]).toEqual([255, 255, 255]);
    expect([...rightCorner]).toEqual([255, 255, 255]);
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
