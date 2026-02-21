import type { Message } from "@grammyjs/types";
import { env } from "@starlight/utils";
import { registerOTel } from "@vercel/otel";
import type { TelemetrySettings } from "ai";
import { LangfuseExporter } from "langfuse-vercel";
import { logger } from "@/logger";
import type { Context } from "@/types";

export function registerTelemetry() {
	if (!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)) {
		return;
	}

	logger.info("Telemetry is established");

	registerOTel({
		serviceName: "starlight-backend",
		traceExporter: new LangfuseExporter({
			publicKey: env.LANGFUSE_PUBLIC_KEY,
			secretKey: env.LANGFUSE_SECRET_KEY,
			baseUrl: env.LANGFUSE_BASEURL,
			environment: env.LANGFUSE_TRACING_ENVIRONMENT,
		}),
	});
}

export function getLangfuseTelemetry(
	ctx: Context & { message: Message }
): TelemetrySettings | undefined {
	if (!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)) {
		return;
	}

	const chatId = String(ctx.chat?.id ?? "unknown");
	const messageThreadId = String(ctx.message.message_thread_id ?? "main");

	return {
		isEnabled: true,
		functionId: "message-reply",
		metadata: {
			chatId,
			messageId: String(ctx.message.message_id),
			messageThreadId,
			userId: ctx.message.from?.id ? String(ctx.message.from.id) : "unknown",
			sessionId: `${chatId}:${messageThreadId}`,
		},
	};
}
