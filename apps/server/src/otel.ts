import { PrismaInstrumentation } from "@prisma/instrumentation";
import env from "@starlight/utils/config";
import { registerOTel } from "@vercel/otel";
import type { TelemetrySettings } from "ai";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseExporter } from "langfuse-vercel";
import { logger } from "@/logger";

export function registerTelemetry() {
	const hasLangfuse = !!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
	const hasAxiom = !!(env.AXIOM_TOKEN && env.AXIOM_DATASET);

	if (!hasLangfuse && !hasAxiom) {
		return;
	}

	logger.info("Telemetry is established");

	const spanProcessors: Array<BatchSpanProcessor | "auto"> = [];

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

	registerOTel({
		serviceName: "starlight-backend",
		traceExporter: hasLangfuse
			? new LangfuseExporter({
					publicKey: env.LANGFUSE_PUBLIC_KEY!,
					secretKey: env.LANGFUSE_SECRET_KEY!,
					baseUrl: env.LANGFUSE_BASEURL,
					environment: env.LANGFUSE_TRACING_ENVIRONMENT,
				})
			: undefined,
		spanProcessors,
		instrumentations: ["auto", new PrismaInstrumentation()],
	});
}

export function getLangfuseTelemetry(
	functionId: string,
	metadata: Record<string, string>,
): TelemetrySettings | undefined {
	if (!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)) {
		return;
	}

	return {
		isEnabled: true,
		functionId,
		metadata,
	};
}
