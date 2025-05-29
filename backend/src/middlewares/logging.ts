import type { Context } from "@/bot";
import type { NextFunction } from "grammy";

async function logUpdates(ctx: Context, next: NextFunction) {
	ctx.logger.debug({ update: ctx.update }, "Received update");

	await next();
}

export default logUpdates;
