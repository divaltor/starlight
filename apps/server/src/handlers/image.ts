import { imagesQueue } from "@/queue/image-collector";
import {
	cancelPublishingFlow,
	createPublishingFlow,
	getActiveFlowsForChat,
} from "@/queue/publishing";
import { scrapperQueue } from "@/queue/scrapper";
import { prisma } from "@/storage";
import type { Context } from "@/types";
import { env } from "@repo/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);

composer.on("inline_query", async (ctx) => {
	const offset = ctx.inlineQuery.offset || "0";
	const photoOffset = Number(offset) || 0;

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
		const tweets = await prisma.tweet.findMany({
			where: {
				userId: ctx.user?.id as string,
				photos: {
					some: {
						deletedAt: null,
						s3Path: { not: null },
					},
				},
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
	const numberOfTweets = ctx.match ? Math.min(Number(ctx.match) || 10, 50) : 10;

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
	const photoGroups: Array<{ photoIds: string[] }> = [];

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

		// Collect photo groups for flow creation
		if (photosBuffer.length > 0) {
			photoGroups.push({
				photoIds: photosBuffer.map((p) => p.id),
			});

			ctx.logger.debug(
				{
					chatId: ctx.chat?.id,
					userId: ctx.user?.id,
					chatType: ctx.chat?.type,
					photosBufferLength: photosBuffer.length,
					jobIndex,
				},
				"Prepared media group %s for chat %s from %s user (group %s)",
				photosBuffer.length,
				ctx.chat?.id,
				ctx.user?.id,
				jobIndex,
			);

			jobIndex++;
		}
	}

	// Create publishing flow with sequential job execution
	if (photoGroups.length > 0) {
		const flowJobId = await createPublishingFlow(
			ctx.chat?.id as number,
			ctx.user?.id as string,
			photoGroups,
			ctx.message?.message_thread_id,
		);

		await ctx.reply(
			`Started publishing ${photoGroups.length} photo groups sequentially. Photos will be sent at a rate of 10 photos per minute.\n\nUse /cancel to stop the publication.`,
		);

		ctx.logger.debug(
			{
				chatId: ctx.chat?.id,
				userId: ctx.user?.id,
				flowJobId,
				photoGroups: photoGroups.length,
			},
			"Created flow with root job %s for chat %s",
			flowJobId.id,
			ctx.chat?.id,
		);
	} else {
		await ctx.reply("No photos to publish, check back later.");
	}
});

groupChat.command("cancel", async (ctx) => {
	const activeFlows = await getActiveFlowsForChat(ctx.chat?.id as number);

	if (activeFlows.length === 0) {
		await ctx.reply("No active publications to cancel.");
		return;
	}

	let totalGroupsCancelled = 0;
	let flowsCancelled = 0;
	
	for (const flowJobId of activeFlows) {
		const result = await cancelPublishingFlow(flowJobId);
		if (result.success) {
			totalGroupsCancelled += result.groupsCancelled;
			flowsCancelled++;
		}
	}

	if (totalGroupsCancelled > 0) {
		await ctx.reply(
			`Cancelled ${totalGroupsCancelled} photo group${totalGroupsCancelled > 1 ? "s" : ""}.`,
		);
	} else {
		await ctx.reply("Failed to cancel publications. They may have already completed.");
	}

	ctx.logger.info(
		{
			chatId: ctx.chat?.id,
			userId: ctx.user?.id,
			cancelledFlows: flowsCancelled,
			totalFlows: activeFlows.length,
			totalGroupsCancelled,
		},
		"User %s cancelled %s flows (%s groups) in chat %s",
		ctx.user?.id,
		flowsCancelled,
		totalGroupsCancelled,
		ctx.chat?.id,
	);
});

export default composer;
