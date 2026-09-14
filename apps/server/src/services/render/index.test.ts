import { expect, test } from "bun:test";
import sharp from "sharp";

test("falls back when an image URL returns invalid bytes", async () => {
  const { renderTweetImage } = await import(".");
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
    server.stop(true);
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
    server.stop(true);
  }
});

test("renders light card bottom corners without dark pixels", async () => {
  const { renderTweetImage } = await import(".");
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
    server.stop(true);
  }
});

test("renders light card bottom corners without dark pixels", async () => {
  const { renderTweetImage } = await import(".");
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
    server.stop(true);
  }
});
