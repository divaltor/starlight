import { FormattedString } from "@grammyjs/parse-mode";
import { CookieEncryption } from "@starlight/crypto";
import { env, isTwitterUrl, type Prisma, prisma } from "@starlight/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { webAppKeyboard } from "@/bot";
import { scrapperQueue } from "@/queue/scrapper";
import { Cookies, redis } from "@/storage";
import type { Context } from "@/types";

const scrapperRateLimiter = new RateLimiterRedis({
	storeClient: redis,
	points: 1, // 1 parsing schedule per 15 minutes
	duration: 60 * 15, // per 15 minutes
	keyPrefix: "scrapper",
});

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");

composer.on("inline_query").filter(
	(ctx) => !isTwitterUrl(ctx.inlineQuery.query.trim()),
	async (ctx) => {
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

		if (photosForThisPage.length === 0 && !ctx.user?.cookies) {
			// User didn't setup the bot yet
			await ctx.answerInlineQuery(
				[
					InlineQueryResultBuilder.article(`id:no-photos:${ctx.from?.id}`, "Oops, no photos...", {
						reply_markup: new InlineKeyboard().url(
							"Set cookies",
							`${env.BASE_FRONTEND_URL}/settings`,
						),
					}).text("No photos found, did you setup the bot?"),
				],
				{
					is_personal: true,
				},
			);

			return;
		}

		const results = photosForThisPage.map((photo) => {
			const caption = photo.username
				? FormattedString.link(`@${photo.username}`, `https://x.com/i/status/${photo.tweetId}`)
				: new FormattedString(`https://x.com/i/status/${photo.tweetId}`);

			return InlineQueryResultBuilder.photo(photo.externalId ?? photo.id, photo.s3Url as string, {
				caption: caption.caption,
				caption_entities: caption.caption_entities,
				thumbnail_url: photo.s3Url as string,
				photo_height: photo.height ?? undefined,
				photo_width: photo.width ?? undefined,
			});
		});

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
	},
);

privateChat.command("cookies").filter(
	async (ctx) => !ctx.user?.cookies,
	async (ctx) => {
		const keyboard = new InlineKeyboard().webApp("Set cookies", {
			url: `${env.BASE_FRONTEND_URL}/settings`,
		});

		await ctx.reply("No cookies found. Please set your cookies first.", {
			reply_markup: keyboard,
		});
	},
);

privateChat.command("cookies").filter(
	async (ctx) => Boolean(ctx.user?.cookies),
	async (ctx) => {
		try {
			const userCookies = ctx.user?.cookies;

			if (!(userCookies && ctx.user)) {
				await ctx.reply("No cookies found.");
				return;
			}

			const cookiesJson = cookieEncryption.safeDecrypt(userCookies, ctx.user.telegramId.toString());

			const cookies = Cookies.fromJSON(cookiesJson);
			const cookiesString = cookies.toString();

			await ctx.reply(`Your cookies:\n\n${cookiesString}`);
		} catch (error) {
			ctx.logger.error({ error }, "Failed to decrypt cookies");
			await ctx.reply("Failed to decrypt cookies. Please try setting them again.");
		}
	},
);

privateChat.command("scrapper").filter(
	async (ctx) => !ctx.user?.cookies,
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
	async (ctx) => Boolean(ctx.user?.cookies),
	async (ctx) => {
		const scheduledJob = await scrapperQueue.getJobScheduler(`scrapper-${ctx.user?.id}`);
		const args = ctx.match;

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

		if (args !== "safe") {
			try {
				await scrapperRateLimiter.consume(ctx.from.id);
			} catch {
				await ctx.reply(
					"Sorry, but we already collected images for you. You can start a job each 15 minutes only for your convenience to not accidentally block your account.",
				);
				return;
			}
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

export default composer;
