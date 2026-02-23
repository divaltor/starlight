import { env } from "@starlight/utils";
import { registerOTel } from "@vercel/otel";
import type { TelemetrySettings } from "ai";
import { LangfuseExporter } from "langfuse-vercel";
import { logger } from "@/logger";

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
	functionId: string,
	metadata: Record<string, string>
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
