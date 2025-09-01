import { b, fmt } from "@grammyjs/parse-mode";
import { env, type Prisma } from "@repo/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { channelKeyboard, webAppKeyboard } from "@/bot";
import { schedulerFlow } from "@/queue/scheduler";
import { scrapperQueue } from "@/queue/scrapper";
import { findDuplicatesByImageContent } from "@/services/duplicate-detection";
import { prisma, redis } from "@/storage";
import type { Context } from "@/types";

const scrapperRateLimiter = new RateLimiterRedis({
	storeClient: redis,
	points: 1, // 1 parsing schedule per 15 minutes
	duration: 60 * 15, // per 15 minutes
	keyPrefix: "scrapper",
});

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);

privateChat.on("message:photo", async (ctx) => {
	const photo = await ctx.getFile();
	const file = await photo.download();

	const similarPhotos = await findDuplicatesByImageContent(file);

	ctx.logger.debug({ similarPhotos }, "Found similar photos");

	if (similarPhotos.length === 0) {
		await ctx.reply("No similar photos found, sorry 😔");
		return;
	}
	if (similarPhotos.length === 1) {
		await ctx.reply(`https://x.com/i/status/${similarPhotos[0]?.tweetId}`);
		return;
	}

	const topMatches = similarPhotos.slice(0, 3);

	let message = "Found similar photos:\n\n";
	for (const [index, photo] of topMatches.entries()) {
		message += `${index + 1}. Similarity: ${photo.distance}\n`;
		message += `https://x.com/i/status/${photo.tweetId}\n\n`;
	}

	await ctx.reply(message);
});

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
					reply_markup: webAppKeyboard("app", "View gallery"),
				},
			);
			return;
		}

		if (slot.status === "PUBLISHED") {
			await ctx.reply("Slot is already published, create new one here 🪶.", {
				reply_markup: webAppKeyboard("publications", "Manage publications"),
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

		const title = fmt`We are publishing your photos to ${b}${slot.postingChannel.chat.title || "your"}${b} channel ✨.`;

		if (slot.postingChannel.chat.username) {
			await ctx.reply(title.text, {
				reply_markup: channelKeyboard(slot.postingChannel.chat.username),
				entities: title.entities,
			});
		} else {
			await ctx.reply(title.text, {
				entities: title.entities,
			});
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
		externalId?: string;
		s3Url: string | null;
		tweetId: string;
		height: number | null;
		width: number | null;
		username?: string;
	}> = [];

	let tweetSkip = 0;
	let totalPhotosFound = 0;

	// Keep fetching tweets until we have enough photos to satisfy the offset + 50 results
	while (totalPhotosFound <= photoOffset + 50) {
		const whereClause: Prisma.TweetWhereInput = {};

		if (query) {
			// Extract author names from query (starting with @)
			const authorMatches = query.match(/@(\w+)/g);
			const authors = authorMatches?.map((match) => match.substring(1)) || [];

			// Remove author mentions from query for text search
			const textQuery = query.replace(/@\w+/g, "").trim();

			// Build where clause
			if (authors.length > 0 && textQuery) {
				// Both author filter and text search
				whereClause.AND = [
					{
						OR: authors.map((author) => ({
							username: { contains: author, mode: "insensitive" },
						})),
					},
					{ tweetText: { contains: textQuery, mode: "insensitive" } },
				];
			} else if (authors.length > 0) {
				// Only author filter
				whereClause.OR = authors.map((author) => ({
					username: { contains: author, mode: "insensitive" },
				}));
			} else if (textQuery) {
				// Only text search
				whereClause.tweetText = { contains: textQuery, mode: "insensitive" };
			}
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
					externalId: photo.externalId,
					s3Url: photo.s3Url as string,
					tweetId: tweet.id,
					height: photo.height,
					width: photo.width,
					username: tweet.tweetData.username,
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
		InlineQueryResultBuilder.photo(photo.externalId ?? photo.id, photo.s3Url as string, {
			caption: photo.username
				? `<a href="https://x.com/i/status/${photo.tweetId}">@${photo.username}</a>`
				: `https://x.com/i/status/${photo.tweetId}`,
			thumbnail_url: photo.s3Url as string,
			photo_height: photo.height ?? undefined,
			photo_width: photo.width ?? undefined,
			parse_mode: "HTML",
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

privateChat.command("scrapper").filter(
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
		const scheduledJob = await scrapperQueue.getJobScheduler(
			`scrapper-${ctx.user?.id}`,
		);

		if (!scheduledJob) {
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

			await ctx.reply(
				"You placed in the queue (runs every 6 hours). You can check your images in a few minutes in your gallery.\n\nYou can start the job anytime by sending /scrapper command again.",
				{
					reply_markup: webAppKeyboard("app", "View gallery"),
				},
			);
			return;
		}

		try {
			await scrapperRateLimiter.consume(ctx.from.id);
		} catch {
			await ctx.reply(
				"Sorry, but we already collected images for you. You can start a job each 15 minutes only for your convenience to not accidentally block your account.",
			);
			return;
		}

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


export default composer;
