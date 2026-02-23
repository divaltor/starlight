import { prisma, toUniqueId } from "@starlight/utils";
import { s3 } from "@/storage";
import type { Context } from "@/types";

export const updateChannelPhoto = async (ctx: Context) => {
	if (!ctx.chat) {
		return;
	}

	try {
		const fullChatInfo = await ctx.getChat();

		ctx.logger.debug(
			{ fullChatInfo },
			"Full chat info for %s channel",
			ctx.chat.title
		);

		if (fullChatInfo.photo) {
			const [thumbnail, big] = await Promise.all([
				ctx.api.getFile(fullChatInfo.photo.small_file_id),
				ctx.api.getFile(fullChatInfo.photo.big_file_id),
			]);

			const [bigFile, thumbnailFile] = await Promise.all([
				big.download(),
				thumbnail.download(),
			]);

			const bigPath = `channels/${toUniqueId(ctx.chat.id)}/big.jpg`;
			const thumbnailPath = `channels/${toUniqueId(ctx.chat.id)}/thumbnail.jpg`;

			await Promise.all([
				s3.write(bigPath, Bun.file(bigFile)),
				s3.write(thumbnailPath, Bun.file(thumbnailFile)),
			]);

			await prisma.chat.update({
				where: {
					id: ctx.chat.id,
				},
				data: {
					photoThumbnail: thumbnailPath,
					photoBig: bigPath,
				},
			});
		}
	} catch (error) {
		ctx.logger.warn(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			"Error getting chat info"
		);
	}
};
