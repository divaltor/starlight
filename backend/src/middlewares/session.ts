import { prisma } from "@/storage";
import type { Context } from "@/types";
import type { NextFunction } from "grammy";

export default async function attachUser(ctx: Context, next: NextFunction) {
	if (!ctx.from) {
		ctx.logger.warn("User not found, skipping session attachment.");
		return await next();
	}

	let user = await prisma.user.findUnique({
		where: {
			telegramId: ctx.from.id,
		},
	});

	if (!user) {
		ctx.logger.warn(
			{ telegramId: ctx.from.id },
			"User not found, creating new user.",
		);

		user = await prisma.user.create({
			data: {
				telegramId: ctx.from.id,
				username: ctx.from.username,
				firstName: ctx.from.first_name,
				lastName: ctx.from.last_name,
				isBot: ctx.from.is_bot,
			},
		});
	}

	ctx.user = user;

	await next();
}
