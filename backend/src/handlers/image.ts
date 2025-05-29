import type { Context } from "@/bot";
import { Cookies } from "@/storage";
import { Scraper } from "@the-convocation/twitter-scraper";
import { Composer } from "grammy";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

composer.on(":web_app_data", async (ctx) => {
	const stringData = ctx.msg.web_app_data;

	ctx.logger.debug({ stringData }, "Web app data received");

	ctx.session.user.cookies = Cookies.fromJSON(stringData.data);

	ctx.logger.debug({ cookies: ctx.session.user.cookies }, "Cookies saved");

	await ctx.reply(
		"Cookies saved, you're placed into the queue. Wait until you're notified.",
	);
});

feature.command("images").filter(
	(ctx) => ctx.session.user.cookies !== null,
	async (ctx) => {
		const scrapper = new Scraper();

		const cookies = ctx.session.user.cookies;

		// biome-ignore lint/style/noNonNullAssertion: cookies is not null from filter
		scrapper.setCookies(cookies!.getCookies());

		// biome-ignore lint/style/noNonNullAssertion: cookies is not null from filter
		const userId = cookies!.userId();

		if (!userId) {
			await ctx.reply("Could not extract user ID from cookies");
			return;
		}

		for await (const tweet of scrapper.getLikedTweets(userId, 30)) {
			ctx.logger.debug({ tweet }, "Liked tweet from user %s", userId);
		}
	},
);

feature.command("images", async (ctx) => {
	await ctx.reply("You're not in the queue, please send cookies first.");
});

export default composer;
