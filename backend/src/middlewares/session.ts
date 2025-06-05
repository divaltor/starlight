import { prisma } from "@/storage";
import type { Context } from "@/types";
import type { NextFunction } from "grammy";

export default async function attachUser(ctx: Context, next: NextFunction) {
	if (!ctx.from) {
		ctx.logger.warn("User not found, skipping session attachment.");
		return await next();
	}

	// PERF: Optimize with SELECT and INSERT or cache via Redis
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
