import { prisma } from "@starlight/utils";
import type { NextFunction } from "grammy";
import type { Context } from "@/types";

export async function attachUser(ctx: Context, next: NextFunction) {
	if (!ctx.from) {
		ctx.logger.warn("User not found, skipping session attachment.");
		return await next();
	}

	const user = await prisma.user.upsert({
		where: {
			telegramId: ctx.from.id,
		},
		create: {
			telegramId: ctx.from.id,
			username: ctx.from.username,
			firstName: ctx.from.first_name,
			lastName: ctx.from.last_name,
			isBot: ctx.from.is_bot,
		},
		update: {
			username: ctx.from.username,
			firstName: ctx.from.first_name,
			lastName: ctx.from.last_name,
		},
	});

	ctx.user = user;

	await next();
}

export async function attachChat(ctx: Context, next: NextFunction) {
	if (!ctx.chat) {
		return await next();
	}

	const chat = await prisma.chat.upsert({
		where: {
			id: ctx.chat.id,
		},
		create: {
			id: ctx.chat.id,
			title: ctx.chat.title,
			username: ctx.chat.username,
		},
		update: {
			title: ctx.chat.title,
			username: ctx.chat.username,
		},
	});

	ctx.userChat = chat;

	await next();
}

export async function attachChatMember(ctx: Context, next: NextFunction) {
	if (
		!(ctx.chat && ctx.from && ctx.user) ||
		(ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")
	) {
		return await next();
	}

	const chatId = BigInt(ctx.chat.id);

	try {
		const existingMember = await prisma.chatMember.findUnique({
			where: {
				chatId_userId: {
					chatId,
					userId: ctx.user.id,
				},
			},
		});

		if (existingMember) {
			ctx.userChatMember = existingMember;
			return await next();
		}

		const telegramMember = await ctx.api.getChatMember(
			ctx.chat.id,
			ctx.from.id
		);

		ctx.userChatMember = await prisma.chatMember.upsert({
			where: {
				chatId_userId: {
					chatId,
					userId: ctx.user.id,
				},
			},
			create: {
				chatId,
				userId: ctx.user.id,
				status: telegramMember.status,
			},
			update: {
				status: telegramMember.status,
			},
		});
	} catch (error) {
		ctx.logger.warn(
			{
				error,
				chatId: ctx.chat.id,
				userId: ctx.from.id,
			},
			"Failed to attach chat member."
		);
	}

	await next();
}
