import { env, type Prisma } from "@repo/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { channelKeyboard, webAppKeyboard } from "@/bot";
import { imagesQueue } from "@/queue/image-collector";
import { publishingQueue } from "@/queue/publishing";
import { schedulerFlow } from "@/queue/scheduler";
import { scrapperQueue } from "@/queue/scrapper";
import { prisma, redis } from "@/storage";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);

privateChat.on(":text").filter(
	(ctx) => ctx.msg.via_bot !== undefined && ctx.msg.text.startsWith("🪶"),
	async (ctx) => {
		const slotId = await redis.getdel(`${ctx.user?.telegramId}:publish`);

		if (!slotId) {
			return;
		}

		const slot = await prisma.scheduledSlot.findUnique({
			where: {
				id: slotId,
				userId: ctx.user?.id as string,
			},
			include: {
				postingChannel: {
					include: {
						chat: true,
					},
				},
				scheduledSlotTweets: {
					include: {
						tweet: {
							include: {
								photos: true,
							},
						},
					},
				},
			},
		});

		if (!slot) {
			return;
		}

		if (slot.status === "PUBLISHING") {
			await ctx.reply(
				"Slot is already being published. While you waiting you can review your gallery ✨",
				{
					reply_markup: webAppKeyboard("app"),
				},
			);
			return;
		}

		if (slot.status === "PUBLISHED") {
			await ctx.reply("Slot is already published, create new one here 🪶.", {
				reply_markup: webAppKeyboard("publications"),
			});
			return;
		}

		await schedulerFlow.add({
			name: "completed-slot",
			queueName: "scheduled-slots",
			data: {
				userId: ctx.user?.id as string,
				slotId,
				status: "PUBLISHED",
			},
			opts: {
				deduplication: {
					id: `completed-slot-${slotId}`,
				},
			},
			children: [
				{
					name: "publishing-slot",
					queueName: "scheduled-slots",
					data: {
						userId: ctx.user?.id as string,
						slotId,
						status: "PUBLISHING",
					},
					opts: {
						removeOnComplete: true,
						removeOnFail: true,
						deduplication: {
							id: `publishing-slot-${slotId}`,
						},
					},
				},
				...slot.scheduledSlotTweets.map((tweet, index) => ({
					name: "scheduled-tweet",
					queueName: "scheduled-tweet",
					data: {
						userId: ctx.user?.id as string,
						slotId,
						tweetId: tweet.id,
					},
					opts: {
						deduplication: {
							id: `scheduled-tweet-${tweet.id}`,
						},
						attempts: 3,
						backoff: 1500,
						delay: index * 1500,
						removeOnComplete: true,
						priority: index,
					},
				})),
			],
		});

		if (slot.postingChannel.chat.username) {
			await ctx.reply(
				`We are publishing your photos to ${slot.postingChannel.chat.title} channel ✨.`,
				{
					reply_markup: channelKeyboard(slot.postingChannel.chat.username),
				},
			);
		} else {
			await ctx.reply(
				`We are publishing your photos to ${slot.postingChannel.chat.title} channel ✨.`,
			);
		}
	},
);

composer.on("inline_query", async (ctx) => {
	const offset = ctx.inlineQuery.offset || "0";
	const photoOffset = Number(offset) || 0;
	const query = ctx.inlineQuery.query.trim();

	// Fetch more tweets than we need to ensure we can find 50 photos
	// We'll fetch in batches and keep going until we have enough photos
	const allPhotos: Array<{
		id: string;
		s3Url: string | null;
		tweetId: string;
	}> = [];

	let tweetSkip = 0;
	let totalPhotosFound = 0;

	// Keep fetching tweets until we have enough photos to satisfy the offset + 50 results
	while (totalPhotosFound <= photoOffset + 50) {
		const whereClause: Prisma.TweetWhereInput = {};

		if (query) {
			whereClause.tweetText = { contains: query, mode: "insensitive" };
		}

		const tweets = await prisma.tweet.findMany({
			where: {
				userId: ctx.user?.id as string,
				photos: {
					some: {
						deletedAt: null,
						s3Path: { not: null },
					},
				},
				...whereClause,
			},
			include: {
				photos: {
					where: {
						deletedAt: null,
						s3Path: { not: null },
					},
					orderBy: {
						createdAt: "desc",
					},
				},
			},
			orderBy: {
				createdAt: "desc",
			},
			take: 50,
			skip: tweetSkip,
		});

		if (tweets.length === 0) {
			break; // No more tweets
		}

		// Flatten photos from this batch
		for (const tweet of tweets) {
			for (const photo of tweet.photos) {
				allPhotos.push({
					id: photo.id,
					s3Url: photo.s3Url as string,
					tweetId: tweet.id,
				});
				totalPhotosFound++;
			}
		}

		tweetSkip += 50;
	}

	// Get the slice of photos for this page
	const photosForThisPage = allPhotos.slice(photoOffset, photoOffset + 50);

	if (photosForThisPage.length === 0) {
		if (ctx.session.cookies === null) {
			// User didn't setup the bot yet
			await ctx.answerInlineQuery(
				[
					InlineQueryResultBuilder.article(
						`id:no-photos:${ctx.from?.id}`,
						"Oops, no photos...",
						{
							reply_markup: new InlineKeyboard().url(
								"Set cookies",
								`${env.BASE_FRONTEND_URL}/settings`,
							),
						},
					).text("No photos found, did you setup the bot?"),
				],
				{
					is_personal: true,
				},
			);

			return;
		}
	}

	const results = photosForThisPage.map((photo) =>
		InlineQueryResultBuilder.photo(photo.id, photo.s3Url as string, {
			caption: `https://x.com/i/status/${photo.tweetId}`,
			thumbnail_url: photo.s3Url as string,
		}),
	);

	// Calculate next offset for pagination
	let nextOffset = "";
	if (results.length === 50 && photoOffset + 50 < allPhotos.length) {
		nextOffset = String(photoOffset + 50);
	}

	await ctx.answerInlineQuery(results, {
		next_offset: nextOffset,
		is_personal: true,
		cache_time: 30,
	});
});

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
					limit: 300, // 1000 is too much for free users
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

	ctx.logger.debug(
		{
			chatId: ctx.chat?.id,
			userId: ctx.user?.id,
			queuedGroups: jobIndex,
		},
		"Queued %s photo groups for publishing. They will be sent at a rate of 10 photos per minute to respect Telegram limits.",
		jobIndex,
	);
});

export default composer;
