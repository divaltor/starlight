import { prisma } from "@starlight/utils";
import { Composer } from "grammy";
import type { ChatMemberUpdated } from "grammy/types";
import type { Context } from "@/types";

const composer = new Composer<Context>();

async function upsertChatMember(update: ChatMemberUpdated) {
	const memberUser = update.new_chat_member.user;

	await prisma.$transaction(async (tx) => {
		const user = await tx.user.upsert({
			where: {
				telegramId: memberUser.id,
			},
			create: {
				telegramId: memberUser.id,
				username: memberUser.username,
				firstName: memberUser.first_name,
				lastName: memberUser.last_name,
				isBot: memberUser.is_bot,
			},
			update: {
				username: memberUser.username,
				firstName: memberUser.first_name,
				lastName: memberUser.last_name,
				isBot: memberUser.is_bot,
			},
		});

		await tx.chat.upsert({
			where: {
				id: update.chat.id,
			},
			create: {
				id: update.chat.id,
				title: update.chat.title,
				username: update.chat.username,
			},
			update: {
				title: update.chat.title,
				username: update.chat.username,
			},
		});

		await tx.chatMember.upsert({
			where: {
				chatId_userId: {
					chatId: BigInt(update.chat.id),
					userId: user.id,
				},
			},
			create: {
				chatId: BigInt(update.chat.id),
				userId: user.id,
				status: update.new_chat_member.status,
			},
			update: {
				status: update.new_chat_member.status,
			},
		});
	});
}

composer.on("chat_member", async (ctx) => {
	try {
		await upsertChatMember(ctx.update.chat_member);
	} catch (error) {
		ctx.logger.warn(
			{
				error,
				chatId: ctx.update.chat_member.chat.id,
				userId: ctx.update.chat_member.new_chat_member.user.id,
			},
			"Failed to process chat member update."
		);
	}
});

composer.on("my_chat_member", async (ctx) => {
	try {
		await upsertChatMember(ctx.update.my_chat_member);
	} catch (error) {
		ctx.logger.warn(
			{
				error,
				chatId: ctx.update.my_chat_member.chat.id,
				userId: ctx.update.my_chat_member.new_chat_member.user.id,
			},
			"Failed to process bot chat member update."
		);
	}
});

export default composer;
