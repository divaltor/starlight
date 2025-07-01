import { createServerFn } from "@tanstack/react-start";
import { InlineQueryResultBuilder } from "grammy";
import { z } from "zod/v4";
import { bot } from "@/lib/actions";
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

		await bot.api.answerWebAppQuery(
			context.queryId,
			InlineQueryResultBuilder.article(
				`publish:${data.slotId}`,
				"Publish",
			).text("Publish"),
		);

		return { success: true };
	});
