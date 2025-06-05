import env from "@/server/config";
import { imagesQueue } from "@/server/queue/image-collector";
import { scrapperQueue } from "@/server/queue/scrapper";
import { redis } from "@/server/storage";
import type { Context } from "@/server/types";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Composer, InlineKeyboard } from "grammy";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

feature.command("queue").filter(
	async (ctx) => {
		const scheduledJob = await scrapperQueue.getJobScheduler(
			`scrapper-${ctx.user?.id}`,
		);

		return scheduledJob === null && ctx.session.cookies !== null;
	},
	async (ctx) => {
		ctx.logger.info("Upserting job scheduler for user %s", ctx.user?.id);

		await scrapperQueue.upsertJobScheduler(
			`scrapper-${ctx.user?.id}`,
			{
				every: 1000 * 60 * 60 * 6, // 6 hours
			},
			{
				data: {
					userId: ctx.user?.id as string,
				},
			},
		);

		ctx.logger.info("Job scheduler upserted for user %s", ctx.user?.id);
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

feature.command("test", async (ctx) => {
	const tweet = await redis.get("tweet:test");

	if (!tweet) {
		await ctx.reply("No tweet found");
		return;
	}

	const photos = JSON.parse(tweet) as Tweet;

	imagesQueue.add("post", {
		tweet: photos,
		userId: ctx.user?.id as string,
	});
});

export default composer;
