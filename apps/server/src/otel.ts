import env from "@starlight/utils/config";
import type { TelemetryOptions } from "ai";

type LangfuseTelemetry = {
	telemetry: TelemetryOptions<Record<string, string>>;
	runtimeContext: Record<string, string>;
};

export function getLangfuseTelemetry(
	functionId: string,
	metadata: Record<string, string>,
): LangfuseTelemetry | undefined {
	if (!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)) {
		return;
	}

	return {
		telemetry: {
			isEnabled: true,
			functionId,
			includeRuntimeContext: Object.fromEntries(Object.keys(metadata).map((key) => [key, true])),
		},
		runtimeContext: metadata,
	};
}
