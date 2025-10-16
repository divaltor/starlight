import { prisma } from "@starlight/utils";
import type { NextFunction } from "grammy";
import type { Context } from "@/types";

export async function attachUser(ctx: Context, next: NextFunction) {
	if (!ctx.from) {
		ctx.logger.warn("User not found, skipping session attachment.");
		return await next();
	}

	// PERF: Cache via Redis
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
	if (!ctx.chat || ctx.chat.type === "private") {
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
