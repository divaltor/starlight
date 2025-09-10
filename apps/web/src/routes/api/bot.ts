import { getPrismaClient } from "@repo/utils";

import { createServerFn } from "@tanstack/react-start";
import { InlineQueryResultBuilder } from "grammy";
import { z } from "zod/v4";
import { bot, redis } from "@/lib/actions";
import { authMiddleware } from "@/middleware/auth";

const publishSchema = z.object({
	slotId: z.string(),
});

export const respondToWebAppData = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(publishSchema)
	.handler(async ({ data, context }) => {
		if (!data) {
			return { success: false, error: "No data provided" };
		}

		if (!context.queryId) {
			return { success: false, error: "No query ID provided" };
		}

		const prisma = getPrismaClient();

		const slot = await prisma.scheduledSlot.findUnique({
			where: {
				id: data.slotId,
				userId: context.databaseUserId,
			},
			include: {
				postingChannel: {
					include: {
						chat: true,
					},
				},
			},
		});

		if (!slot) {
			return { success: false, error: "Slot not found" };
		}

		const postingChannel = slot.postingChannel;

		await redis.setex(`${context.user.id}:publish`, 60 * 5, slot.id);

		await bot.api.answerWebAppQuery(
			context.queryId,
			InlineQueryResultBuilder.article(
				`${data.slotId}`,
				`Publish slot ${postingChannel.chat.title}`
			).text(`🪶 ${postingChannel.chat.title}`)
		);

		return { success: true };
	});
