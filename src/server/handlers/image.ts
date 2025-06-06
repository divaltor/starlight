import env from "@/server/config";
import { imagesQueue } from "@/server/queue/image-collector";
import { scrapperQueue } from "@/server/queue/scrapper";
import type { Context } from "@/server/types";
import { Composer, InlineKeyboard } from "grammy";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

feature.command("queue").filter(
	async (ctx) => {
		const scheduledJob = await scrapperQueue.getJobScheduler(
			`scrapper-${ctx.user?.id}`,
		);

		return !scheduledJob && ctx.session.cookies !== null;
	},
	async (ctx) => {
		ctx.logger.debug("Upserting job scheduler for user %s", ctx.user?.id);

		await scrapperQueue.upsertJobScheduler(
			`scrapper-${ctx.user?.id}`,
			{
				every: 1000 * 60 * 60 * 6, // 6 hours
			},
			{
				data: {
					userId: ctx.user?.id as string,
					count: 0,
					limit: 1000,
				},
				name: `scrapper-${ctx.user?.id}`,
			},
		);

		await ctx.reply("Starting to collect images, check back in a few minutes.");

		ctx.logger.debug("Job scheduler upserted for user %s", ctx.user?.id);
	},
);

feature.command("queue").filter(
	async (ctx) => {
		const scheduledJob = await imagesQueue.getJobScheduler(
			`scrapper-${ctx.user?.id}`,
		);

		return !scheduledJob;
	},
	async (ctx) => {
		await ctx.reply(
			"Your images are being collected, check back in a few minutes.",
		);
	},
);

feature.command("queue").filter(
	async (ctx) => ctx.session.cookies === null,
	async (ctx) => {
		const keyboard = new InlineKeyboard().webApp("Set cookies", {
			url: `${env.BASE_FRONTEND_URL}/cookies`,
		});

		await ctx.reply(
			"Beep boop, you need to give me your cookies before I can send you daily images.",
			{ reply_markup: keyboard },
		);
	},
);

export default composer;
