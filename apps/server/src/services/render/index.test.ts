import { expect, test } from "bun:test";

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
