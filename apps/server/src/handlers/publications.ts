import { b, fmt } from "@grammyjs/parse-mode";
import { env } from "@repo/utils";
import { Composer, InlineKeyboard } from "grammy";
import { bot } from "@/bot";
import { prisma } from "@/storage";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const channelChat = composer.chatType("channel");
const privateChat = composer.chatType("private");

const keyboard = new InlineKeyboard().webApp(
	"Manage publications",
	`${env.BASE_FRONTEND_URL}/publications`,
);

privateChat.command("connect", async (ctx) => {
	await ctx.reply(
		fmt`Please, to connect a channel add me as an administrator to a group or channel and write that command there.\n\n${b}Required permissions${b} - send and delete messages.`
			.text,
	);
});

privateChat.command("disconnect", async (ctx) => {
	await ctx.reply("To disconnect a channel use web app interface.", {
		reply_markup: keyboard,
	});
});

channelChat.command("connect", async (ctx) => {
	try {
		await ctx.deleteMessage();
	} catch (error) {
		ctx.logger.warn(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			"Error deleting message",
		);
	}

	const chat = ctx.chat;

	const botMember = await ctx.api.getChatMember(chat.id, ctx.me.id);

	if (botMember.status !== "administrator") {
		await bot.api.sendMessage(
			ctx.from?.id as number,
			fmt`❌ I don't have permission to send messages in channel - ${b}${chat.title}${b}!\n\nPlease add me as an administrator with permissions to send and delete messages, then try again.`
				.text,
		);
		return;
	}

	const existingChannel = await prisma.postingChannel.findFirst({
		where: {
			userId: ctx.user?.id as string,
			chatId: chat.id,
		},
	});

	if (existingChannel) {
		if (existingChannel.isActive) {
			await bot.api.sendMessage(
				ctx.from?.id as number,
				fmt`✅ Channel ${b}${chat.title}${b} is already connected!\n\nYou can manage your publications using the web app.`
					.text,
				{ reply_markup: keyboard },
			);
		} else {
			await prisma.postingChannel.update({
				where: {
					userId_chatId: {
						userId: ctx.user?.id as string,
						chatId: chat.id,
					},
				},
				data: { isActive: true },
			});

			await bot.api.sendMessage(
				ctx.from?.id as number,
				fmt`✅ Channel ${b}${chat.title}${b} was reconnected!\n\nYou can manage your publications using the web app.`
					.text,
				{ reply_markup: keyboard },
			);
		}
		return;
	}

	await prisma.postingChannel.create({
		data: {
			userId: ctx.user?.id as string,
			chatId: chat.id,
		},
	});

	ctx.logger.info(
		{
			userId: ctx.user?.id,
			chatId: chat.id,
		},
		"Created new posting channel connection for user %s in chat %s",
		ctx.user?.id,
		chat.title,
	);

	await bot.api.sendMessage(
		ctx.from?.id as number,
		fmt`🎉 Channel ${b}${chat.title}${b} connected! Open the publications manager to start scheduling posts:`
			.text,
		{ reply_markup: keyboard },
	);
});

export default composer;
