import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { readResponseBounded } from "@/services/media-download";
import { buildFfmpegConcat, extractUgoiraZip, parsePixivArtworkUrl } from "@/services/pixiv-media";

describe("parsePixivArtworkUrl", () => {
	test("accepts only canonical HTTPS artwork URLs", () => {
		expect(parsePixivArtworkUrl("https://www.pixiv.net/artworks/12345")).toBe("12345");
		expect(parsePixivArtworkUrl("https://pixiv.net/artworks/12345/")).toBe("12345");
		expect(parsePixivArtworkUrl("http://www.pixiv.net/artworks/12345")).toBeNull();
		expect(parsePixivArtworkUrl("https://pixiv.net.evil.test/artworks/12345")).toBeNull();
		expect(parsePixivArtworkUrl("https://www.pixiv.net/users/12345")).toBeNull();
	});
});

describe("ugoira conversion input", () => {
	test("preserves variable frame delays", () => {
		expect(
			buildFfmpegConcat([
				{ file: "a.jpg", delay: 40 },
				{ file: "b.jpg", delay: 125 },
			]),
		).toContain("duration 0.04\nfile 'b.jpg'\nduration 0.125");
	});

	test("rejects traversal in frame metadata", async () => {
		const zip = new JSZip();
		zip.file("frame.jpg", "data");
		const archive = await zip.generateAsync({ type: "arraybuffer" });
		expect(extractUgoiraZip(archive, [{ file: "../frame.jpg", delay: 100 }])).rejects.toThrow(
			"Unsafe ugoira archive path",
		);
	});

	test("bounds declared and streamed download sizes", async () => {
		const declared = new Response("small", {
			headers: { "content-length": "100" },
		});
		await expect(readResponseBounded(declared, 10)).rejects.toThrow("too large");
		const streamed = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(8));
					controller.enqueue(new Uint8Array(8));
					controller.close();
				},
			}),
		);
		await expect(readResponseBounded(streamed, 10)).rejects.toThrow("too large");
	});

	test("bounds cumulative extraction and removes failed temp directories", async () => {
		const glob = new Bun.Glob("starlight-ugoira-*");
		const temporaryDirectory = Bun.env.TMPDIR ?? "/tmp";
		const before = new Set(await Array.fromAsync(glob.scan({ cwd: temporaryDirectory })));
		const zip = new JSZip();
		zip.file("a.jpg", new Uint8Array(8));
		zip.file("b.jpg", new Uint8Array(8));
		const archive = await zip.generateAsync({ type: "arraybuffer" });
		expect(
			extractUgoiraZip(
				archive,
				[
					{ file: "a.jpg", delay: 100 },
					{ file: "b.jpg", delay: 100 },
				],
				{ uncompressed: 10 },
			),
		).rejects.toThrow("too large");
		const after = await Array.fromAsync(glob.scan({ cwd: temporaryDirectory }));
		const leakedDirectories: string[] = [];
		for (const entry of after) {
			if (!before.has(entry)) {
				leakedDirectories.push(entry);
			}
		}
		expect(leakedDirectories).toEqual([]);
	});
});
