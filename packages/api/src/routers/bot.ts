import { ORPCError } from "@orpc/client";
import { env, prisma } from "@starlight/utils";
import { Bot, InlineQueryResultBuilder } from "grammy";
import { z } from "zod";
import { protectedProcedure } from "../middlewares/auth";

const bot = new Bot(env.BOT_TOKEN);

export const respondToWebAppData = protectedProcedure
	.input(
		z.object({
			slotId: z.string(),
		})
	)
	.handler(async ({ input, context }) => {
		if (!input.slotId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No slot ID provided",
				status: 400,
			});
		}

		if (!context.queryId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No query ID provided",
				status: 400,
			});
		}

		const slot = await prisma.scheduledSlot.findUnique({
			where: {
				id: input.slotId,
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
			throw new ORPCError("NOT_FOUND", {
				message: "Slot not found",
				status: 404,
			});
		}

		const postingChannel = slot.postingChannel;

		// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
		await Bun.redis.setex(`${context.databaseUserId}:publish`, 60 * 5, slot.id);

		await bot.api.answerWebAppQuery(
			context.queryId,
			InlineQueryResultBuilder.article(
				`${input.slotId}`,
				`Publish slot ${postingChannel.chat.title}`
			).text(`🪶 ${postingChannel.chat.title}`)
		);
	});
