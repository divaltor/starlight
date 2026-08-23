import { hasTwitterCookies } from "@starlight/api/services/twitter-credential";
import { env, prisma } from "@starlight/utils";
import { Composer, InlineKeyboard } from "grammy";
import { webAppKeyboard } from "@/bot";
import type { Logger } from "@/logger";
import { pixivQueue, SCHEDULED_PIXIV_INTERVAL_SECONDS } from "@/queue/pixiv";
import {
	FEED_SCRAPPER_QUEUE,
	scrapperQueue,
	SCHEDULED_SCRAPPER_INTERVAL_SECONDS,
} from "@/queue/scrapper";
import type { Context } from "@/types";

type ProviderCollectionResult = {
	immediateStarted: boolean;
	scheduleReady: boolean;
};

type ProviderConnection = "connected" | "disconnected" | "lookup-failed";

type ScrapperConnections = {
	pixiv: ProviderConnection;
	twitter: ProviderConnection;
};

const composer = new Composer<Context>();
const privateChat = composer.chatType("private");

async function getScrapperConnections(ctx: Context): Promise<ScrapperConnections> {
	const user = ctx.user!;
	const [twitter, pixivCredential] = await Promise.allSettled([
		hasTwitterCookies(user.id),
		prisma.providerCredential.findUnique({
			where: { userId_provider: { userId: user.id, provider: "pixiv" } },
			select: { credentialType: true },
		}),
	]);
	if (twitter.status === "rejected") {
		ctx.logger.warn(
			{ error: twitter.reason, userId: user.id, provider: "twitter" },
			"Failed to check provider connection",
		);
	}
	if (pixivCredential.status === "rejected") {
		ctx.logger.warn(
			{ error: pixivCredential.reason, userId: user.id, provider: "pixiv" },
			"Failed to check provider connection",
		);
	}

	return {
		twitter:
			twitter.status === "rejected"
				? "lookup-failed"
				: twitter.value
					? "connected"
					: "disconnected",
		pixiv:
			pixivCredential.status === "rejected"
				? "lookup-failed"
				: pixivCredential.value?.credentialType === "refresh_token"
					? "connected"
					: "disconnected",
	};
}

async function startTwitterCollection(
	userId: string,
	updateId: number,
	logger: Logger,
): Promise<ProviderCollectionResult> {
	let scheduleReady = false;

	try {
		const schedulerId = `scrapper-${userId}`;
		const scheduledJob = await scrapperQueue.getJobScheduler(schedulerId);
		await scrapperQueue.upsertJobScheduler(
			schedulerId,
			{ every: SCHEDULED_SCRAPPER_INTERVAL_SECONDS * 1000 },
			{ name: FEED_SCRAPPER_QUEUE, data: { count: 0, limit: 300, userId } },
		);
		scheduleReady = true;
		if (!scheduledJob) {
			logger.debug({ userId, provider: "twitter" }, "Scheduled collector");
		}
	} catch (error) {
		logger.warn({ error, userId, provider: "twitter" }, "Failed to schedule collector");
	}

	let immediateStarted = false;
	try {
		await scrapperQueue.add(
			FEED_SCRAPPER_QUEUE,
			{ userId, count: 0, limit: scheduleReady ? 300 : 100 },
			{
				deduplication: { id: `manual-scrapper-${userId}-${updateId}` },
			},
		);
		immediateStarted = true;
	} catch (error) {
		logger.warn({ error, userId, provider: "twitter" }, "Failed to start collector");
	}

	return { immediateStarted, scheduleReady };
}

async function startPixivCollection(
	userId: string,
	updateId: number,
	logger: Logger,
): Promise<ProviderCollectionResult> {
	const runId = `manual-${userId}-${updateId}`;
	const [schedule, immediate] = await Promise.allSettled([
		pixivQueue.upsertJobScheduler(
			`pixiv-${userId}`,
			{ every: SCHEDULED_PIXIV_INTERVAL_SECONDS * 1000 },
			{ name: "pixiv-bookmarks", data: { userId, runId: "scheduled", count: 0, limit: 300 } },
		),
		pixivQueue.add(
			"pixiv-bookmarks",
			{ userId, runId, count: 0, limit: 300 },
			{
				deduplication: { id: `pixiv-${userId}-${runId}` },
			},
		),
	]);

	if (schedule.status === "rejected") {
		logger.warn(
			{ error: schedule.reason, userId, provider: "pixiv" },
			"Failed to schedule collector",
		);
	}
	if (immediate.status === "rejected") {
		logger.warn(
			{ error: immediate.reason, userId, provider: "pixiv" },
			"Failed to start collector",
		);
	}

	return {
		immediateStarted: immediate.status === "fulfilled",
		scheduleReady: schedule.status === "fulfilled",
	};
}

privateChat.command("scrapper", async (ctx) => {
	const user = ctx.user!;
	const connections = await getScrapperConnections(ctx);
	const hasConnectedProvider =
		connections.twitter === "connected" || connections.pixiv === "connected";

	if (!hasConnectedProvider) {
		const lookupFailures = [
			connections.twitter === "lookup-failed" && "• Twitter: connection check failed.",
			connections.pixiv === "lookup-failed" && "• Pixiv: connection check failed.",
		].filter((line) => line !== false);
		const keyboard = new InlineKeyboard().webApp("Connect providers", {
			url: `${env.BASE_FRONTEND_URL}/settings`,
		});
		await ctx.reply(
			lookupFailures.length > 0
				? [
						"Collection was not started:",
						...lookupFailures,
						"Try /scrapper again. Connect any disconnected providers in Settings.",
					].join("\n")
				: "Connect Twitter or Pixiv in Settings before starting collection.",
			{ reply_markup: keyboard },
		);
	} else {
		const [twitter, pixiv] = await Promise.all([
			connections.twitter === "connected"
				? startTwitterCollection(user.id, ctx.update.update_id, ctx.logger)
				: Promise.resolve(null),
			connections.pixiv === "connected"
				? startPixivCollection(user.id, ctx.update.update_id, ctx.logger)
				: Promise.resolve(null),
		]);
		const results = [
			twitter && { provider: "Twitter", ...twitter },
			pixiv && { provider: "Pixiv", ...pixiv },
		].filter((result) => result !== null);
		const lookupFailures = [
			connections.twitter === "lookup-failed" &&
				"• Twitter: connection check failed; collection was not started.",
			connections.pixiv === "lookup-failed" &&
				"• Pixiv: connection check failed; collection was not started.",
		].filter((line) => line !== false);
		const complete =
			lookupFailures.length === 0 &&
			results.every((result) => result.immediateStarted && result.scheduleReady);
		const lines = results.map(
			(result) =>
				`• ${result.provider}: sync ${result.immediateStarted ? "started" : "failed"}; recurring schedule ${result.scheduleReady ? "ready" : "failed"}.`,
		);

		await ctx.reply(
			[
				complete ? "Collection started:" : "Collection was only partially started:",
				...lines,
				...lookupFailures,
				results.some((result) => result.immediateStarted)
					? "Check your gallery in a few minutes."
					: "No immediate sync started. Try /scrapper again.",
			].join("\n"),
			{ reply_markup: webAppKeyboard("app", "View gallery") },
		);
	}
});

export default composer;
