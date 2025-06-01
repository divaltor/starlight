import type { Context } from "@/bot";
import { Cookies } from "@/storage";
import { Scraper } from "@the-convocation/twitter-scraper";
import { Composer, InlineKeyboard } from "grammy";

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

feature.command("images").filter(
	(ctx) => ctx.session.cookies !== null,
	async (ctx) => {
		const scrapper = new Scraper();

		const cookies = ctx.session.cookies;

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
