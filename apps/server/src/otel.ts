import env from "@starlight/utils/config";
import type { TelemetrySettings } from "ai";
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
