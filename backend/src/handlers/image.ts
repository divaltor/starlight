import type { Context } from "@/bot";
import { type S3Photo, imagesQueue } from "@/queue/image-collector";
import { Cookies, redis, timelineKey, tweetKey } from "@/storage";
import { Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { sleep } from "bun";
import { Composer, InlineKeyboard, InputMediaBuilder } from "grammy";
import type { InputMediaPhoto } from "grammy/types";

const composer = new Composer<Context>();

const feature = composer.chatType("private");


feature.command(["cookies", "cookie"], async (ctx) => {
	const keyboard = new InlineKeyboard().webApp("Set cookies", {
		url: "https://starlight.click/cookies",
	});

	await ctx.reply(
		"Beep boop, you need to give me your cookies before I can send you daily images.",
		{ reply_markup: keyboard },
	);
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
				{ tweet, telegram: { userId: telegramUserId, chatId: ctx.chatId } },
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


feature.command("images", async (ctx) => {
	const images = await redis.zrange(timelineKey(ctx.from.id), 0, -1);

	const buffer: InputMediaPhoto[] = [];

	ctx.logger.debug({ images }, "Images to send");

	for (const tweetId of images) {
		const redisTweet = (await redis.call(
			"JSON.GET",
			tweetKey(ctx.from.id, tweetId),
			"$.photos[*]",
		)) as string | null;

		// We store each tweet in sorted set and separately, should not happen
		// Only for linter
		if (!redisTweet) {
			continue;
		}

		const photos = JSON.parse(redisTweet) as S3Photo[];

		for (const photo of photos) {
			buffer.push(InputMediaBuilder.photo(photo.s3Url));

			if (buffer.length === 10) {
				await ctx.replyWithMediaGroup(buffer);
				buffer.length = 0;
				await sleep(1000);
			}
		}
	}

	if (buffer.length > 0) {
		await ctx.replyWithMediaGroup(buffer);
	}
});

export default composer;
