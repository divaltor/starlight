import env from "@/config";
import { imagesQueue } from "@/queue/image-collector";
import { scrapperQueue } from "@/queue/scrapper";
import { Cookies, prisma, redis } from "@/storage";
import type { Context } from "@/types";
import type { Photo, Tweet } from "@/utils";
import { Composer, InlineKeyboard, InputMediaBuilder } from "grammy";
import type { InputMediaPhoto } from "grammy/types";

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType("group");

privateChat.command("queue").filter(
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

privateChat.command("queue").filter(
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

privateChat.command("queue").filter(
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

privateChat.command("scrapper").filter(
	async (ctx) => ctx.session.cookies !== null,
	async (ctx) => {
		await scrapperQueue.add(
			"scrapper",
			{
				userId: ctx.user?.id as string,
				count: 0,
				limit: 100,
			},
			{
				deduplication: {
					id: `scrapper-${ctx.user?.id}`,
				},
			},
		);

		await ctx.reply("Starting to collect images, check back in a few minutes.");
	},
);

groupChat.command("publish", async (ctx) => {
	const numberOfTweets = ctx.match ? Number(ctx.match) || 100 : 100;

	const tweetsWithUnpublishedPhotos = await prisma.tweet.findMany({
		where: {
			userId: ctx.user?.id as string,
			photos: {
				some: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: {
						none: {
							chatId: ctx.chat?.id,
						},
					},
				},
			},
		},
		include: {
			photos: {
				where: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: {
						none: {
							chatId: ctx.chat?.id,
						},
					},
				},
			},
		},
		orderBy: {
			createdAt: "desc",
		},
		take: numberOfTweets,
	});

	// Convert tweets to items with photo counts for bin-packing
	const tweetItems = tweetsWithUnpublishedPhotos.map((tweet, index) => ({
		index,
		photoCount: tweet.photos.length,
		photos: tweet.photos.map((photo) =>
			InputMediaBuilder.photo(photo.s3Path as string),
		),
	}));

	const usedTweets = new Set<number>();

	while (usedTweets.size < tweetItems.length) {
		const imagesBuffer: InputMediaPhoto[] = [];
		let remainingCapacity = 10;

		// First-fit decreasing: try to fit tweets starting with larger ones
		const availableTweets = tweetItems
			.filter((item) => !usedTweets.has(item.index))
			.sort((a, b) => b.photoCount - a.photoCount);

		// Greedy bin-packing: keep adding tweets that fit
		let addedAny = true;
		while (addedAny && remainingCapacity > 0) {
			addedAny = false;

			for (const tweet of availableTweets) {
				if (usedTweets.has(tweet.index)) continue;

				if (tweet.photoCount <= remainingCapacity) {
					imagesBuffer.push(...tweet.photos);
					remainingCapacity -= tweet.photoCount;
					usedTweets.add(tweet.index);
					addedAny = true;
					break; // Start over to maintain first-fit approach
				}
			}
		}

		// If no tweets could fit (edge case), force add the smallest available tweet
		if (imagesBuffer.length === 0) {
			const smallestTweet = availableTweets
				.filter((item) => !usedTweets.has(item.index))
				.sort((a, b) => a.photoCount - b.photoCount)[0];

			if (smallestTweet) {
				imagesBuffer.push(...smallestTweet.photos.slice(0, 10));
				usedTweets.add(smallestTweet.index);
			}
		}

		// Send the buffer
		if (imagesBuffer.length > 0) {
			await ctx.replyWithMediaGroup(imagesBuffer);
		}
	}
});

export default composer;
