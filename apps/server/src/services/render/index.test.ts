import { expect, test } from "bun:test";
import sharp from "sharp";

test("falls back when an image URL returns invalid bytes", async () => {
	process.env.NODE_ENV = "development";
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

test("renders light card bottom corners without dark pixels", async () => {
  process.env.NODE_ENV = "development";
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
