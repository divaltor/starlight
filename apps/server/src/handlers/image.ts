import env from "@/config";
import { imagesQueue } from "@/queue/image-collector";
import { publishingQueue } from "@/queue/publishing";
import { scrapperQueue } from "@/queue/scrapper";
import { prisma } from "@/storage";
import type { Context } from "@/types";
import { Composer, InlineKeyboard } from "grammy";

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);

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

privateChat.command("publish", async (ctx) => {
	await ctx.reply(
		"Please, add me to a group and publish images there.\n\nI should have permissions to delete message to be able to delete your command for cleaner UX.",
	);
});

groupChat.command("source").filter(
	async (ctx) =>
		ctx.message.reply_to_message === undefined ||
		ctx.message.reply_to_message?.photo?.length === 0,
	async (ctx) => {
		await ctx.reply("Please, reply to a message with a photo.");
	},
);

groupChat.command("source").filter(
	async (ctx) => ctx.message.reply_to_message !== undefined,
	async (ctx) => {
		const tweet = await prisma.publishedPhoto.findFirst({
			where: {
				messageId: ctx.message.reply_to_message?.message_id as number,
			},
			include: {
				photo: {
					select: {
						tweetId: true,
					},
				},
			},
		});

		if (!tweet) {
			// Impossible to happen, but just in case
			await ctx.reply("No source found, sorry.");
			return;
		}

		await ctx.reply(`https://x.com/i/status/${tweet.photo.tweetId}`);
	},
);

groupChat.command("publish", async (ctx) => {
	const numberOfTweets = ctx.match
		? Math.min(Number(ctx.match) || 100, 100)
		: 100;

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

	if (tweetsWithUnpublishedPhotos.length === 0) {
		await ctx.reply("No photos to publish, check back later.");
		return;
	}

	// Convert tweets to items with photo counts for bin-packing
	const tweetItems = tweetsWithUnpublishedPhotos.map((tweet, index) => ({
		index,
		photoCount: tweet.photos.length,
		photos: tweet.photos.map((photo) => ({
			id: photo.id,
			s3Path: photo.s3Path as string,
		})),
	}));

	const usedTweets = new Set<number>();
	let jobIndex = 0;

	while (usedTweets.size < tweetItems.length) {
		const photosBuffer: { id: string; s3Path: string }[] = [];
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
					photosBuffer.push(...tweet.photos);
					remainingCapacity -= tweet.photoCount;
					usedTweets.add(tweet.index);
					addedAny = true;
					break; // Start over to maintain first-fit approach
				}
			}
		}

		// If no tweets could fit (edge case), force add the smallest available tweet
		if (photosBuffer.length === 0) {
			const smallestTweet = availableTweets
				.filter((item) => !usedTweets.has(item.index))
				.sort((a, b) => a.photoCount - b.photoCount)[0];

			if (smallestTweet) {
				photosBuffer.push(...smallestTweet.photos.slice(0, 10));
				usedTweets.add(smallestTweet.index);
			}
		}

		// Add to publishing queue instead of sending directly
		if (photosBuffer.length > 0) {
			await publishingQueue.add("publish-photos", {
				chatId: ctx.chat?.id as number,
				userId: ctx.user?.id as string,
				photoIds: photosBuffer.map((p) => p.id),
				topicId: ctx.message?.message_thread_id,
			});

			ctx.logger.debug(
				{
					chatId: ctx.chat?.id,
					userId: ctx.user?.id,
					chatType: ctx.chat?.type,
					photosBufferLength: photosBuffer.length,
					jobIndex,
				},
				"Queued media group %s to chat %s from %s user (job %s)",
				photosBuffer.length,
				ctx.chat?.id,
				ctx.user?.id,
				jobIndex,
			);

			jobIndex++;
		}
	}

	await ctx.reply(
		`Queued ${jobIndex} photo groups for publishing. They will be sent at a rate of 10 photos per minute to respect Telegram limits.`,
	);
});

export default composer;
