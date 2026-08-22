import env from "@starlight/utils/config";

export function getLangfuseTelemetry(functionId: string, metadata: Record<string, string>) {
	if (!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)) {
		return {};
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
