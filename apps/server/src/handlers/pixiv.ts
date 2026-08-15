import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPixivClient } from "@starlight/api/services/pixiv-credential";
import { Composer, InputFile } from "grammy";
import { readResponseBounded } from "@/services/media-download";
import { getScheduledPixivGeneration, pixivApp } from "@/queue/pixiv";
import { RETRY } from "@/queue/absurd";
import {
	convertUgoira,
	extractUgoiraZip,
	MAX_PIXIV_DOWNLOAD_BYTES,
	parsePixivArtworkUrl,
} from "@/services/pixiv-media";
import type { Context } from "@/types";

const MAX_MANGA_BYTES = 150_000_000;
const pixivHandler = new Composer<Context>();

pixivHandler.command("pixiv", async (ctx) => {
	if (!ctx.user) {
		return;
	}
	const generation = getScheduledPixivGeneration();
	await pixivApp.spawn(
		"scheduled-pixiv-bookmarks",
		{ generation, userId: ctx.user.id, limit: 300 },
		{
			idempotencyKey: `scheduled-pixiv-${ctx.user.id}-${generation}`,
			maxAttempts: 3,
			retryStrategy: RETRY.pixiv,
		},
	);
	await pixivApp.spawn(
		"pixiv-bookmarks",
		{ userId: ctx.user.id, runId: `manual-${randomUUID()}`, count: 0, limit: 300 },
		{ maxAttempts: 3, retryStrategy: RETRY.pixiv },
	);
	await ctx.reply("Starting Pixiv bookmark sync. Check your gallery in a few minutes.");
});

pixivHandler.on("message:text", async (ctx, next) => {
	const id = parsePixivArtworkUrl(ctx.message.text.trim());
	if (!id) {
		return next();
	}
	if (!ctx.user) {
		return;
	}
	const directory = await mkdtemp(join(tmpdir(), "starlight-pixiv-"));
	try {
		const handled = await withPixivClient(ctx.user.id, async (client) => {
			const artwork = await client.artwork(id);
			if (artwork.type === "ugoira") {
				const metadata = await client.ugoira(id);
				const archive = await readResponseBounded(await client.fetchMedia(metadata.zipUrls.medium));
				const extracted = await extractUgoiraZip(archive, metadata.frames);
				try {
					const output = join(extracted.directory, "ugoira.mp4");
					await convertUgoira(extracted.concatPath, output);
					await ctx.replyWithVideo(new InputFile(output), {
						caption: artwork.title,
					});
				} finally {
					await rm(extracted.directory, { recursive: true, force: true });
				}
				return true;
			}

			let aggregateBytes = 0;
			const files: InputFile[] = [];
			for (const [position, url] of artwork.mediaUrls.entries()) {
				const bytes = await readResponseBounded(
					await client.fetchMedia(url),
					Math.min(MAX_PIXIV_DOWNLOAD_BYTES, MAX_MANGA_BYTES - aggregateBytes),
				);
				aggregateBytes += bytes.byteLength;
				const extension = new URL(url).pathname.split(".").at(-1) ?? "jpg";
				const path = join(directory, `${position}.${extension}`);
				await writeFile(path, bytes);
				files.push(new InputFile(path));
			}
			for (let offset = 0; offset < files.length; offset += 10) {
				const chunk = files.slice(offset, offset + 10);
				const single = chunk.at(0);
				if (chunk.length === 1 && single) {
					await ctx.replyWithDocument(single, { caption: artwork.title });
				} else {
					await ctx.replyWithMediaGroup(
						chunk.map((file, index) => ({
							type: "document" as const,
							media: file,
							caption: index === 0 ? artwork.title : undefined,
						})),
					);
				}
			}
			return true;
		});
		if (handled === undefined) {
			await ctx.reply("Connect Pixiv in Settings first.");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

export default pixivHandler;
