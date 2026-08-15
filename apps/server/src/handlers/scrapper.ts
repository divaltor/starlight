import { hasTwitterCookies } from "@starlight/api/services/twitter-credential";
import { env, prisma } from "@starlight/utils";
import { Composer, InlineKeyboard } from "grammy";
import { webAppKeyboard } from "@/bot";
import type { Logger } from "@/logger";
import { RETRY } from "@/queue/absurd";
import { getScheduledPixivGeneration, pixivApp } from "@/queue/pixiv";
import { getScheduledScrapperGeneration, scrapperApp } from "@/queue/scrapper";
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
const scrapperConnections = new WeakMap<Context, Promise<ScrapperConnections>>();

function getScrapperConnections(ctx: Context) {
	let connections = scrapperConnections.get(ctx);
	if (!connections) {
		const user = ctx.user!;
		connections = Promise.allSettled([
			hasTwitterCookies(user.id),
			prisma.providerCredential.findUnique({
				where: { userId_provider: { userId: user.id, provider: "pixiv" } },
				select: { credentialType: true },
			}),
		]).then(([twitter, pixivCredential]) => {
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
		});
		scrapperConnections.set(ctx, connections);
	}
	return connections;
}

async function startTwitterCollection(
	userId: string,
	updateId: number,
	logger: Logger,
): Promise<ProviderCollectionResult> {
	const generation = getScheduledScrapperGeneration();
	let scheduleReady = false;
	let firstSchedule = false;

	try {
		const scheduledJob = await scrapperApp.spawn(
			"scheduled-feed-scrapper",
			{ generation, userId, limit: 300 },
			{
				idempotencyKey: `scheduled-scrapper-${userId}-${generation}`,
				maxAttempts: 3,
				retryStrategy: RETRY.scrapper,
			},
		);
		scheduleReady = true;
		firstSchedule = scheduledJob.created;
		if (firstSchedule) {
			logger.debug({ userId, provider: "twitter" }, "Scheduled collector");
		}
	} catch (error) {
		logger.warn({ error, userId, provider: "twitter" }, "Failed to schedule collector");
	}

	let immediateStarted = false;
	try {
		await scrapperApp.spawn(
			"feed-scrapper",
			{ userId, count: 0, limit: firstSchedule ? 300 : 100 },
			{
				idempotencyKey: `manual-scrapper-${userId}-${updateId}`,
				maxAttempts: 3,
				retryStrategy: RETRY.scrapper,
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
	const generation = getScheduledPixivGeneration();
	const runId = `manual-${userId}-${updateId}`;
	const [schedule, immediate] = await Promise.allSettled([
		pixivApp.spawn(
			"scheduled-pixiv-bookmarks",
			{ generation, userId, limit: 300 },
			{
				idempotencyKey: `scheduled-pixiv-${userId}-${generation}`,
				maxAttempts: 3,
				retryStrategy: RETRY.pixiv,
			},
		),
		pixivApp.spawn(
			"pixiv-bookmarks",
			{ userId, runId, count: 0, limit: 300 },
			{
				idempotencyKey: `pixiv-${userId}-${runId}`,
				maxAttempts: 3,
				retryStrategy: RETRY.pixiv,
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

privateChat.command("scrapper").filter(
	async (ctx) => {
		const connections = await getScrapperConnections(ctx);
		return connections.twitter !== "connected" && connections.pixiv !== "connected";
	},
	async (ctx) => {
		const connections = await getScrapperConnections(ctx);
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
	},
);

privateChat.command("scrapper").filter(
	async (ctx) => {
		const connections = await getScrapperConnections(ctx);
		return connections.twitter === "connected" || connections.pixiv === "connected";
	},
	async (ctx) => {
		const user = ctx.user!;
		const connections = await getScrapperConnections(ctx);
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
	},
);

export default composer;
