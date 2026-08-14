import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import env from "@starlight/utils/config";
import { registerTelemetry } from "ai";
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
			[ATTR_SERVICE_NAME]: "starlight-backend",
		}),
		spanProcessors,
	});

	provider.register();

	registerInstrumentations({
		tracerProvider: provider,
		instrumentations: [new PrismaInstrumentation(), new PinoInstrumentation()],
	});
}

export function shutdownTelemetry() {
	if (!provider) {
		return Promise.resolve();
	}

	shutdownPromise ??= provider.shutdown();

	return shutdownPromise;
}
