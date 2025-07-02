import type { NextFunction } from "grammy";
import type { Context } from "@/bot";

async function logUpdates(ctx: Context, next: NextFunction) {
	ctx.logger.debug({ update: ctx.update }, "Received update");

	await next();
}

export default logUpdates;
