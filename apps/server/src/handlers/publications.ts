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
	const text = fmt`Please, to connect a channel add me as an administrator to a group or channel and write that command there.\n\n${b}Required permissions${b} - send and delete messages.`;
	await ctx.reply(text.text, {
		entities: text.entities,
	});
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
	const creator = await ctx.api.getChatAdministrators(chat.id);

	const creatorId = creator.find((admin) => admin.status === "creator")?.user
		.id;

	// It's literally impossible to happen because admins can add other bots as admins only and we can't get wrong information from that API
	if (!creatorId) {
		ctx.logger.warn(
			{
				chatId: chat.id,
				chatTitle: chat.title,
			},
			"Can't find creator in channel %s",
			chat.title,
		);
		return;
	}

	const user = await prisma.user.findUnique({
		where: {
			telegramId: creatorId,
		},
	});

	if (!user) {
		ctx.logger.warn(
			{
				chatId: chat.id,
				chatTitle: chat.title,
			},
			"Can't find user in database",
		);
		return;
	}

	const botMember = await ctx.api.getChatMember(chat.id, ctx.me.id);

	if (
		botMember.status !== "administrator" ||
		!botMember.can_post_messages ||
		!botMember.can_delete_messages ||
		!botMember.can_edit_messages
	) {
		const text = fmt`❌ I don't have required permissions in channel - ${b}${chat.title}${b}!\n\nPlease add me as an administrator with permissions to send, delete and edit messages, then try again.`;
		await bot.api.sendMessage(creatorId, text.text, {
			entities: text.entities,
		});
		return;
	}

	const existingChannel = await prisma.postingChannel.findFirst({
		where: {
			userId: user.id,
			chatId: chat.id,
		},
	});

	if (existingChannel) {
		if (existingChannel.isActive) {
			const text = fmt`✅ Channel ${b}${chat.title}${b} is already connected!\n\nYou can manage your publications using the web app.`;
			await bot.api.sendMessage(creatorId, text.text, {
				entities: text.entities,
				reply_markup: keyboard,
			});
		} else {
			const text = fmt`✅ Channel ${b}${chat.title}${b} was reconnected!\n\nYou can manage your publications using the web app.`;
			await prisma.postingChannel.update({
				where: {
					userId_chatId: {
						userId: user.id,
						chatId: chat.id,
					},
				},
				data: { isActive: true },
			});

			await bot.api.sendMessage(creatorId, text.text, {
				entities: text.entities,
				reply_markup: keyboard,
			});
		}
		return;
	}

	await prisma.postingChannel.create({
		data: {
			userId: user.id,
			chatId: chat.id,
		},
	});

	ctx.logger.info(
		{
			userId: user.id,
			chatId: chat.id,
		},
		"Created new posting channel connection for user %s in chat %s",
		user.id,
		chat.title,
	);

	const text = fmt`🎉 Channel ${b}${chat.title}${b} connected! Open the publications manager to start scheduling posts:`;
	await bot.api.sendMessage(creatorId, text.text, {
		entities: text.entities,
		reply_markup: keyboard,
	});
});

export default composer;
