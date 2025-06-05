import env from "@/config";
import { imagesQueue } from "@/queue/image-collector";
import { scrapperQueue } from "@/queue/scrapper";
import { Cookies, prisma, redis } from "@/storage";
import type { UserContext } from "@/types";
import { Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { sleep } from "bun";
import { Composer, InlineKeyboard, InputMediaBuilder } from "grammy";
import type { InputMediaPhoto } from "grammy/types";

const composer = new Composer<UserContext>();

const feature = composer.chatType("private");

feature.command("queue").filter(async (ctx) => {
	const scheduledJob = await scrapperQueue.getJobScheduler(
		`scrapper-${ctx.user.id}`,
	);

	return scheduledJob === null && ctx.session.cookies !== null;
});

feature.command("queue").filter(
	(ctx) => ctx.session.cookies !== null,
	async (ctx) => {
		const scrapper = new Scraper();

		// biome-ignore lint/style/noNonNullAssertion: <explanation>
		const cookies = Cookies.fromJSON(ctx.session.cookies!);

		// https://github.com/the-convocation/twitter-scraper/issues/110
		await scrapper.setCookies(cookies.toString().split(";"));

		// biome-ignore lint/style/noNonNullAssertion: cookies is not null from filter
		const twitterUserId = cookies!.userId();
		const telegramUserId = ctx.from.id;

		if (!twitterUserId) {
			ctx.logger.warn("Could not extract user ID from cookies");
			await ctx.reply("Could not extract user ID from cookies");
			return;
		}

		ctx.logger.debug(
			{ userId: twitterUserId },
			"User ID extracted from cookies",
		);
		ctx.logger.info("Starting to get liked tweets for user %s", twitterUserId);

		const likedTweets = await scrapper.fetchLikedTweets(twitterUserId, 200);

		for (const tweet of likedTweets.tweets) {
			imagesQueue.add(
				"post",
				{ tweet, userId: ctx.user.id },
				{
					deduplication: {
						id: tweet.id
							? `${telegramUserId}:${tweet.id}`
							: `${telegramUserId}:${crypto.randomUUID()}`,
						ttl: 1000 * 60 * 60 * 24, // 1 day
					},
				},
			);
			ctx.logger.debug({ tweetId: tweet.id }, "Added tweet to queue");
		}
	},
);

feature.command("queue", async (ctx) => {
	const keyboard = new InlineKeyboard().webApp("Set cookies", {
		url: `${env.BASE_FRONTEND_URL}/cookies`,
	});

	await ctx.reply(
		"Beep boop, you need to give me your cookies before I can send you daily images.",
		{ reply_markup: keyboard },
	);
});

feature.command("images", async (ctx) => {
	const buffer: InputMediaPhoto[] = [];

	const photos = await prisma.photo.findMany({
		where: {
			userId: ctx.user.id,
			s3Path: { not: null },
		},
	});

	for (const photo of photos) {
		// It won't trigger `originalUrl`, just for linter
		buffer.push(InputMediaBuilder.photo(photo.s3Url ?? photo.originalUrl));

		if (buffer.length === 10) {
			await ctx.replyWithMediaGroup(buffer);
			buffer.length = 0;
			await sleep(1000);
		}
	}

	if (buffer.length > 0) {
		await ctx.replyWithMediaGroup(buffer);
	}
});

export default composer;
