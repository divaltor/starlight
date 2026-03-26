import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import env from "@starlight/utils/config";
import { logger } from "@/logger";

let sdk: NodeSDK | undefined;
let shutdownPromise: Promise<void> | undefined;

export function initTelemetry() {
	if (sdk) {
		return;
	}

	const hasLangfuse = !!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
	const hasAxiom = !!(env.AXIOM_TOKEN && env.AXIOM_DATASET);

	if (!hasLangfuse && !hasAxiom) {
		return;
	}

	logger.info("Telemetry is established");

	const spanProcessors: SpanProcessor[] = [];

	if (hasLangfuse) {
		spanProcessors.push(
			new LangfuseSpanProcessor({
				publicKey: env.LANGFUSE_PUBLIC_KEY!,
				secretKey: env.LANGFUSE_SECRET_KEY!,
				baseUrl: env.LANGFUSE_BASE_URL,
				environment: env.LANGFUSE_TRACING_ENVIRONMENT,
			}),
		);
	}

	if (hasAxiom) {
		const axiomExporter = new OTLPTraceExporter({
			url: `${env.AXIOM_BASE_URL}/v1/traces`,
			headers: {
				Authorization: `Bearer ${env.AXIOM_TOKEN}`,
				"X-Axiom-Dataset": env.AXIOM_DATASET,
			},
		});

		spanProcessors.push(new BatchSpanProcessor(axiomExporter));
	}

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
