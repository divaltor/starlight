import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPixivClient } from "@starlight/api/services/pixiv-credential";
import { Composer, InputFile } from "grammy";
import { readResponseBounded } from "@/services/media-download";
import {
	convertUgoira,
	extractUgoiraZip,
	MAX_PIXIV_DOWNLOAD_BYTES,
	parsePixivArtworkUrl,
} from "@/services/pixiv-media";
import type { Context } from "@/types";

const MAX_MANGA_BYTES = 150_000_000;
const pixivHandler = new Composer<Context>();

pixivHandler.on("message:text").filter(
	(ctx) => parsePixivArtworkUrl(ctx.message.text.trim()) !== null,
	async (ctx) => {
		const id = parsePixivArtworkUrl(ctx.message.text.trim())!;
		const user = ctx.user!;
		const directory = await mkdtemp(join(tmpdir(), "starlight-pixiv-"));
		try {
			const handled = await withPixivClient(user.id, async (client) => {
				const artwork = await client.artwork(id);
				if (artwork.type === "ugoira") {
					const metadata = await client.ugoira(id);
					const archive = await readResponseBounded(
						await client.fetchMedia(metadata.zipUrls.medium),
					);
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
	},
);

export default pixivHandler;
