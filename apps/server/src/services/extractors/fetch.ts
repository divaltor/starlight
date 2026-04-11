import { http } from "@starlight/utils/http";
import { isTimeoutError } from "ky";
import UserAgent from "user-agents";
import type { Extractor, ExtractionResult } from "@/services/extractors/base";
import { logger } from "@/logger";

export class FetchExtractor implements Extractor {
	isEnabled(): boolean {
		return true;
	}

	async extract(url: string): Promise<ExtractionResult | null> {
		logger.info("FetchExtractor: Starting extraction for %s", url);

		let response: Awaited<ReturnType<typeof http>>;

		try {
			response = await http(url, {
				headers: {
					Accept: "text/markdown",
					"User-Agent": new UserAgent().toString(),
				},
				hooks: {
					beforeError: [
						({ error }) => {
							if (isTimeoutError(error)) {
								logger.warn({ url }, "FetchExtractor: Fetch timeout");
							} else {
								logger.error({ error, url }, "FetchExtractor: Fetch failed");
							}

							return error;
						},
					],
				},
			});
		} catch {
			return null;
		}

		if (!response.ok) {
			logger.info("FetchExtractor: Failed to fetch %s, status %s", url, response.status);
			return null;
		}

		const contentType = response.headers.get("content-type");
		const body = await response.text();

		if (contentType?.includes("text/markdown")) {
			logger.info(
				"FetchExtractor: Extracted markdown content from %s (%s bytes)",
				url,
				body.length,
			);
			return { kind: "markdown", content: body };
		}

		logger.info("FetchExtractor: Extracted HTML content from %s (%s bytes)", url, body.length);
		return { kind: "html", content: body };
	}
}
