import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import env from "@starlight/utils/config";
import { registerTelemetry } from "ai";
import { logger } from "@/logger";

let sdk: NodeSDK | undefined;
let shutdownPromise: Promise<void> | undefined;

export function initTelemetry() {
	if (sdk) {
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

	sdk = new NodeSDK({
		serviceName: "starlight-backend",
		spanProcessors,
		instrumentations: [new PrismaInstrumentation(), new PinoInstrumentation()],
	});

	sdk.start();
}

export function shutdownTelemetry() {
	if (!sdk) {
		return Promise.resolve();
	}

	shutdownPromise ??= sdk.shutdown();

	return shutdownPromise;
}
