import type { Update } from "@grammyjs/types";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { MiddlewareFn } from "grammy";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import env from "@starlight/utils/config";
import { registerTelemetry } from "ai";
import type { Context } from "@/types";
import { logger } from "@/logger";

let provider: NodeTracerProvider | undefined;
let shutdownPromise: Promise<void> | undefined;

export function initTelemetry() {
	if (provider) {
		return;
	}

	const hasLangfuse = !!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);

	if (!hasLangfuse) {
		return;
	}

	logger.info("Telemetry is established");
	registerTelemetry(new OpenTelemetry({ runtimeContext: true }));

	const spanProcessors: SpanProcessor[] = [
		new LangfuseSpanProcessor({
			publicKey: env.LANGFUSE_PUBLIC_KEY!,
			secretKey: env.LANGFUSE_SECRET_KEY!,
			baseUrl: env.LANGFUSE_BASE_URL,
			environment: env.LANGFUSE_TRACING_ENVIRONMENT,
		}),
	];

	provider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: "starlight-bot",
		}),
		spanProcessors,
	});

	provider.register();

	registerInstrumentations({
		tracerProvider: provider,
		instrumentations: [new PrismaInstrumentation(), new PinoInstrumentation()],
	});
}

export function createUpdateTracer(
	options: { attributes?: (ctx: Context) => Record<string, string | number | undefined> } = {},
): MiddlewareFn<Context> {
	return (ctx, next) =>
		trace.getTracer("starlight-bot").startActiveSpan(updateSpanName(ctx.update), async (span) => {
			try {
				for (const [key, value] of Object.entries({
					"telegram.update.id": ctx.update.update_id,
					...options.attributes?.(ctx),
				})) {
					if (value !== undefined) {
						span.setAttribute(key, value);
					}
				}
				await next();
			} catch (error) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				if (error instanceof Error) {
					span.recordException(error);
				} else {
					span.recordException(String(error));
				}
				throw error;
			} finally {
				span.end();
			}
		});
}

function updateSpanName(update: Update): string {
	const updateType = Object.keys(update).find((key) => key !== "update_id");
	return `update.${updateType ?? "unknown"}`;
}

export function shutdownTelemetry() {
	if (!provider) {
		return Promise.resolve();
	}

	shutdownPromise ??= provider.shutdown();

	return shutdownPromise;
}
